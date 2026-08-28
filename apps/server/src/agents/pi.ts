import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type {
	AgentStreamEvent,
	Message,
	MessagePart,
	UsageTotals,
} from "@dilna/shared";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
} from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	getEnvApiKey,
	type ImageContent,
	streamSimple,
	type TextContent,
	Type,
	type Usage,
} from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import {
	type BashOperations,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLocalBashOperations,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { getDataDir } from "../db";
import {
	getRepoMemory,
	REPO_MEMORY_MAX_CHARS,
	setRepoMemory,
} from "../repos/memory";
import { createConfinementHook } from "./confinement";
import {
	createOrchestratorTools,
	ORCHESTRATOR_SYSTEM_PROMPT,
	type OrchestratorDeps,
} from "./orchestratorTools";

export type { OrchestratorDeps };

import type { DilnaProvider } from "./providerConfig";
import type { AgentChatOptions } from "./types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type Listener = (event: AgentStreamEvent) => void;

export type PiStartOptions = {
	/** dilna's own stable session id — passed straight through as `Agent`'s
	 * `sessionId` construction option (provider cache-affinity hint). No
	 * separate id is minted; see `docs/research/pi-agent-type-migration.md`
	 * on why `Session.agentSessionId` was dropped entirely. */
	sessionId: string;
	worktreePath: string;
	/** The Session's owning Repo (memory is scoped per-Repo, not per-Session —
	 * see ADR-0018). */
	repoId: string;
	/** dilna's own persisted history, already converted to pi's transcript
	 * shape via {@link dilnaMessagesToInitialState}. Empty for a session's
	 * first-ever turn. Every cold start (first turn, post-idle-kill respawn,
	 * post-server-restart) reconstructs from this — there is no separate
	 * "resume by id" path the way Claude's transcript-backed resume needed,
	 * since pi keeps no external transcript of its own to resume from. */
	initialMessages: AgentMessage[];
};

/**
 * `pi-agent-core`'s bare `Agent` is a plain in-process object, not a
 * subprocess wrapper (unlike `claude.ts`'s `ClaudeHandle`, which exists to
 * bridge a resident CLI subprocess) — see
 * docs/research/pi-manager-dispatch.md §0. So there is no
 * `agentSessionId`/`apiKeySource`/`lastAssistantTranscriptUuid` (nothing
 * external to bridge), no `exitListeners` (a failed provider call surfaces
 * as `agent.state.messages`' trailing entry, inspected directly by
 * {@link chatPi} — not a separate crash channel; see that function's doc
 * comment), and no input queue (call `handle.agent.prompt(text)` directly).
 */
export type PiHandle = {
	kind: "pi";
	worktreePath: string;
	agent: Agent;
	listeners: Set<Listener>;
	stop: () => Promise<void>;
	isAlive: () => boolean;
	/** Always empty — pi has no subprocess to capture stderr from. Kept only
	 * for shape-parity with `failTurn`'s `detail.stderrTail` field, which
	 * every `turn_failed` broadcast (Claude- or pi-sourced) fills in the same
	 * way. */
	stderrTail: string[];
};

// ---- Worktree/toolchain plumbing (ported from claude.ts — see that file's
// own doc comments for the full incident history behind each grant; not
// re-explained per line here, only what differs for pi) --------------------

/**
 * See `claude.ts`'s identical helper: a git worktree's `.git` is a file
 * pointing at metadata under the origin repo's actual git dir, whose
 * `commondir` in turn points at the *shared* git dir (objects/refs/config).
 * Sandboxed bash needs write access to that shared dir directly — `git
 * commit`/`git branch` fail read-only against it otherwise.
 */
function resolveGitCommonDir(worktreePath: string): string | null {
	try {
		const dotGit = readFileSync(path.join(worktreePath, ".git"), "utf8");
		const match = dotGit.match(/^gitdir:\s*(.+)$/m);
		const worktreeGitDir = match?.[1]?.trim();
		if (!worktreeGitDir) return null;
		const commondir = readFileSync(
			path.join(worktreeGitDir, "commondir"),
			"utf8",
		).trim();
		return path.resolve(worktreeGitDir, commondir);
	} catch {
		return null;
	}
}

/** Root for every toolchain's per-user install/cache/config state (ADR-0012,
 * issue #83) — mirrors `claude.ts`'s `TOOLCHAIN_HOME`. Rooted under
 * `DILNA_DATA_DIR` (not `$HOME`) so it survives a pod restart. */
const TOOLCHAIN_HOME = path.join(getDataDir(), "toolchain-home");
const MISE_DATA_DIR = path.join(TOOLCHAIN_HOME, "mise", "data");
const MISE_CONFIG_DIR = path.join(TOOLCHAIN_HOME, "mise", "config");
const MISE_CACHE_DIR = path.join(TOOLCHAIN_HOME, "mise", "cache");
const MISE_STATE_DIR = path.join(TOOLCHAIN_HOME, "mise", "state");
const XDG_CACHE_HOME = path.join(TOOLCHAIN_HOME, "cache");
const XDG_DATA_HOME = path.join(TOOLCHAIN_HOME, "xdg-data");
const XDG_CONFIG_HOME = path.join(TOOLCHAIN_HOME, "xdg-config");
const GH_CONFIG_DIR = path.join(TOOLCHAIN_HOME, "gh-config");
const PNPM_STORE_DIR = path.join(TOOLCHAIN_HOME, "pnpm", "store");

const TOOLCHAIN_WRITABLE_PATHS = [
	MISE_DATA_DIR,
	MISE_CONFIG_DIR,
	MISE_CACHE_DIR,
	MISE_STATE_DIR,
	XDG_CACHE_HOME,
	path.join(XDG_CACHE_HOME, "sigstore-rust"),
	XDG_DATA_HOME,
	XDG_CONFIG_HOME,
	GH_CONFIG_DIR,
	path.join(XDG_CACHE_HOME, "gh"),
	PNPM_STORE_DIR,
];

/** A writable-path grant only does anything once the host directory already
 * exists (see `claude.ts`'s identical note) — pre-create every leaf before
 * the sandboxed bash tool's first use. */
function ensureWritablePathsExist(): void {
	for (const dir of TOOLCHAIN_WRITABLE_PATHS) {
		mkdirSync(dir, { recursive: true });
	}
}

/** Toolchain env vars injected into every sandboxed bash call — see
 * `claude.ts`'s identical env block for why each one is needed. */
function toolchainEnv(worktreePath: string): NodeJS.ProcessEnv {
	return {
		MISE_TRUSTED_CONFIG_PATHS: [
			process.env.MISE_TRUSTED_CONFIG_PATHS,
			worktreePath,
		]
			.filter(Boolean)
			.join(":"),
		npm_config_store_dir: process.env.npm_config_store_dir ?? PNPM_STORE_DIR,
		MISE_DATA_DIR: process.env.MISE_DATA_DIR ?? MISE_DATA_DIR,
		MISE_CONFIG_DIR: process.env.MISE_CONFIG_DIR ?? MISE_CONFIG_DIR,
		MISE_CACHE_DIR: process.env.MISE_CACHE_DIR ?? MISE_CACHE_DIR,
		MISE_STATE_DIR: process.env.MISE_STATE_DIR ?? MISE_STATE_DIR,
		XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? XDG_CACHE_HOME,
		XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? XDG_DATA_HOME,
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? XDG_CONFIG_HOME,
		GH_CONFIG_DIR: process.env.GH_CONFIG_DIR ?? GH_CONFIG_DIR,
	};
}

const DILNA_AGENT_CONTEXT = `You are running headless inside dilna, a self-hosted workspace that drives coding agents against locally-cloned repos.

- Your cwd is a git worktree checked out to its own branch, created solely for this session — not the repo's main checkout. Other sessions on the same repo run in sibling worktrees; you won't see their uncommitted work and they won't see yours.
- Every tool call is confined to this worktree: the read/write/edit/grep/find/ls tools refuse a path that resolves outside it (directly, via \`../\`, or via a symlink), and bash commands run inside a sandbox confined to the same boundary (plus the shared git object store, so git history/commit/branch commands work). A write outside that boundary fails with a clear error — that's the confinement, not a bug; there is no escape-hatch flag to bypass it, so widen the actual grant or report the gap instead of trying to work around it.
- Tool calls run autonomously with no human present to answer prompts — act rather than pausing to ask.
- Only the shell process itself resets between separate bash tool calls — exported env vars, shell functions, and sourced profile state don't carry over, so re-\`export\`/re-\`source\` anything a later call needs. The working directory and everything actually written to disk persists, and that includes $HOME: it's the same on-disk directory across every bash call in this session, and across every other session this dilna instance spawns, not wiped or reprovisioned per call. So a toolchain installed via \`mise install\`/\`pnpm install\` stays installed — check \`command -v <tool>\` before paying for a fresh install (it may already be there from earlier in this session, or from a previous one), rather than re-chaining the full install before every later command that needs it.
- Nothing runtime-specific is guaranteed pre-installed for the repo you're in. Use mise (already on PATH) to get whatever toolchain it needs: \`mise install\` picks up versions from the repo's own .tool-versions/.nvmrc/.python-version/mise.toml if present, or \`mise use <tool>@<version>\` to pick one yourself. This covers node, pnpm (via corepack once node is installed), go, python, rust, ruby, and more.`;

function repoMemorySystemPromptSection(memoryContent: string): string {
	if (!memoryContent) return "";
	return `\n\n## Repo memory\n\nFacts a previous session recorded about this Repo (not this Worktree — every Session gets an isolated Worktree, but memory carries over since it's scoped to the Repo). Use the \`update_repo_memory\` tool to add, edit, or remove entries; that tool replaces this whole section, so read it here before editing it.\n\n${memoryContent}`;
}

const UPDATE_REPO_MEMORY_TOOL_DESCRIPTION = `Replace this Repo's persistent memory with short, durable facts that should carry over to every future Session on this Repo (e.g. "tests need FOO_ENV set", "this suite is flaky on CI", "don't hand-edit the generated file, it's overwritten by build"). Every Session gets an isolated, throwaway Worktree, so without this a fact discovered in one Session is invisible to the next.

This call REPLACES the entire memory, it does not append — read the current content from the "Repo memory" section of your system prompt (if present), then send back the full edited text (add/edit/remove entries as needed). Pass an empty string to clear it entirely.

Keep it to short, standalone facts, not procedures, task notes, or anything specific to the current conversation. Hard cap: ${REPO_MEMORY_MAX_CHARS} characters — an over-limit call is rejected with an error, so trim before resubmitting rather than getting truncated silently.`;

const updateRepoMemorySchema = Type.Object({ content: Type.String() });

function createUpdateRepoMemoryTool(
	repoId: string,
): AgentTool<typeof updateRepoMemorySchema> {
	return {
		name: "update_repo_memory",
		label: "Update repo memory",
		description: UPDATE_REPO_MEMORY_TOOL_DESCRIPTION,
		parameters: updateRepoMemorySchema,
		execute: async (_toolCallId, params) => {
			const result = await setRepoMemory(repoId, params.content);
			if (!result.ok) throw new Error(result.error);
			return {
				content: [{ type: "text" as const, text: "Repo memory updated." }],
				details: {},
			};
		},
	};
}

/**
 * Wraps pi-coding-agent's default local bash operations so every command runs
 * through `sandbox-runtime`'s existing `wrapWithSandbox` path (already proven
 * working for Claude — ADR-0010/ADR-0019) rather than reimplementing process
 * spawning/streaming/timeout/abort handling ourselves. `SandboxManager` is a
 * process-wide singleton (`sandbox-manager.d.ts`'s own doc comment), but
 * `wrapWithSandbox`'s `customConfig` param is read per call rather than
 * mutating that shared state (confirmed by reading the installed
 * implementation directly) — so concurrent sessions on different worktrees
 * each get their own scoped `filesystem.allowWrite` without racing each
 * other, despite sharing one `SandboxManager`.
 */
function createSandboxedBashOperations(
	worktreePath: string,
	writablePaths: string[],
	denyReadPaths: string[],
): BashOperations {
	const local = createLocalBashOperations();
	return {
		async exec(command, cwd, options) {
			const wrapped = await SandboxManager.wrapWithSandbox(
				command,
				undefined,
				{
					filesystem: {
						denyRead: denyReadPaths,
						// Re-open the worktree (and everything it's otherwise allowed to
						// write) for reads within the broader deny — denyReadPaths is
						// only ever the dilna checkout root when the worktree happens to
						// be nested inside it (see startPi's nestedInCheckout), and
						// without this the worktree itself would go unreadable too.
						allowRead: writablePaths,
						allowWrite: writablePaths,
						denyWrite: [],
					},
				},
				options.signal,
			);
			return local.exec(wrapped, cwd, {
				...options,
				env: { ...options.env, ...toolchainEnv(worktreePath) },
			});
		},
	};
}

let sandboxInitialized: Promise<void> | null = null;
/**
 * `SandboxManager.initialize()` needs to run once per process before
 * `wrapWithSandbox` works at all (platform checks, proxy/MITM setup for
 * network restriction). The actual per-session filesystem policy is applied
 * per call via `wrapWithSandbox`'s `customConfig`, not here — this baseline
 * matches `claude.ts`'s own sandbox config: no domain restriction (agents
 * need arbitrary outbound access; a headless session has no human to answer
 * an approval prompt for a blocked domain), filesystem left to each call's
 * own `customConfig`.
 *
 * `enableWeakerNestedSandbox` mirrors `claude.ts`'s identical setting: set
 * only inside dilna's own Docker image (`DILNA_CONTAINERIZED=true` in the
 * Dockerfile) — bwrap can't mount a fresh `/proc` inside an already-
 * unprivileged container, so it bind-mounts the container's existing one
 * instead. Only safe when an outer container already provides the real
 * isolation boundary (true in the reference deployment, not for bare-host
 * dev). `sandbox-runtime`'s `SandboxRuntimeConfig` has this exact field
 * (confirmed in the installed `dist/sandbox/sandbox-config.d.ts`) — without
 * it, every sandboxed bash call would fail outright inside the container.
 */
function ensureSandboxInitialized(): Promise<void> {
	if (!sandboxInitialized) {
		sandboxInitialized = SandboxManager.initialize({
			network: { allowedDomains: ["*"], deniedDomains: [] },
			filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
			enableWeakerNestedSandbox: process.env.DILNA_CONTAINERIZED === "true",
		});
	}
	return sandboxInitialized;
}

/**
 * Walk up from `start` to find dilna's own monorepo root (marked by
 * `pnpm-workspace.yaml`) — mirrors `claude.ts`'s identical helper, used the
 * same way: detecting whether `DILNA_DATA_DIR` lives nested inside dilna's
 * own checkout, so a session's read tools don't accidentally pick up dilna's
 * own CLAUDE.md while confined to someone else's worktree.
 */
function findWorkspaceRoot(start: string): string {
	let dir = start;
	while (true) {
		if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return start;
		dir = parent;
	}
}

/**
 * Construct a fresh `pi-agent-core` `Agent` for a session, seeded with dilna's
 * own persisted history (`opts.initialMessages`). Every cold start — first
 * turn ever, post-idle-kill respawn, post-server-restart — goes through this
 * exact same path; there is no separate "resume by id" branch (see
 * `PiStartOptions.initialMessages`'s doc comment).
 */
export async function startPi(opts: PiStartOptions): Promise<PiHandle> {
	ensureWritablePathsExist();
	await ensureSandboxInitialized();

	const provider = process.env.DILNA_PROVIDER as DilnaProvider;
	const modelId = process.env.DILNA_MODEL as string;
	const model = getBuiltinModels(provider).find((m) => m.id === modelId);
	if (!model) {
		// Server startup validation (providerConfig.ts) already guarantees
		// this; only reachable if DILNA_PROVIDER/DILNA_MODEL changed after
		// boot without a restart.
		throw new Error(
			`DILNA_PROVIDER=${provider}/DILNA_MODEL=${modelId} is no longer a valid combination`,
		);
	}

	const gitCommonDir = resolveGitCommonDir(opts.worktreePath);
	const workspaceRoot = findWorkspaceRoot(__dirname);
	const dataDir = getDataDir();
	const nestedInCheckout = dataDir.startsWith(`${workspaceRoot}${path.sep}`);
	const repoMemoryContent = await getRepoMemory(opts.repoId);

	const systemPrompt =
		DILNA_AGENT_CONTEXT +
		repoMemorySystemPromptSection(repoMemoryContent) +
		(nestedInCheckout
			? `\n\nNote: this worktree happens to live nested inside dilna's own checkout on the host filesystem — the read/grep/find/ls tools are confined to this worktree regardless, so dilna's own project files are not reachable from here.`
			: "");

	const bashWritablePaths = [
		opts.worktreePath,
		...TOOLCHAIN_WRITABLE_PATHS,
		...(gitCommonDir ? [gitCommonDir] : []),
	];

	// biome-ignore lint/suspicious/noExplicitAny: AgentTool<any> is the library's own alias for a type-erased tool (pi-coding-agent's `Tool` type)
	const tools: AgentTool<any>[] = [
		createReadTool(opts.worktreePath),
		createWriteTool(opts.worktreePath),
		createEditTool(opts.worktreePath),
		createGrepTool(opts.worktreePath),
		createFindTool(opts.worktreePath),
		createLsTool(opts.worktreePath),
		createBashTool(opts.worktreePath, {
			operations: createSandboxedBashOperations(
				opts.worktreePath,
				bashWritablePaths,
				nestedInCheckout ? [workspaceRoot] : [],
			),
		}),
		createUpdateRepoMemoryTool(opts.repoId),
	];

	const agent = new Agent({
		initialState: {
			systemPrompt,
			model,
			tools,
			messages: opts.initialMessages,
		},
		sessionId: opts.sessionId,
		streamFn: streamSimple,
		getApiKey: (p) => getEnvApiKey(p, process.env as Record<string, string>),
		beforeToolCall: createConfinementHook(opts.worktreePath),
	});

	return wirePiHandle(agent, opts.worktreePath);
}

/**
 * The event-plumbing/lifecycle tail every `PiHandle` needs regardless of
 * which tools its `Agent` was built with — shared by `startPi` and
 * `startOrchestrator` so the two only differ in what actually varies
 * (system prompt, tool set, sandbox/confinement).
 */
function wirePiHandle(agent: Agent, worktreePath: string): PiHandle {
	const listeners = new Set<Listener>();
	const state: NormalizeState = createNormalizeState();
	agent.subscribe((event) => {
		const events = normalizePiEvent(event, state);
		for (const ev of events) {
			for (const listener of listeners) {
				try {
					listener(ev);
				} catch {
					// listener errors are non-fatal
				}
			}
		}
	});

	let stopped = false;
	const stop = async () => {
		if (stopped) return;
		stopped = true;
		agent.abort();
		await agent.waitForIdle();
		listeners.clear();
	};

	return {
		kind: "pi",
		worktreePath,
		agent,
		listeners,
		stop,
		isAlive: () => !stopped,
		stderrTail: [],
	};
}

export type OrchestratorStartOptions = {
	sessionId: string;
	worktreePath: string;
	initialMessages: AgentMessage[];
	deps: OrchestratorDeps;
};

/**
 * Construct a `pi-agent-core` `Agent` for an orchestrator Session (ADR-0021):
 * no read/write/edit/grep/find/ls/bash tools, no sandbox, no confinement
 * hook — there's nothing filesystem-shaped for this Agent to touch, only
 * `orchestratorTools.ts`'s dilna-internals tools. Otherwise mirrors
 * `startPi`: same model resolution, same `wirePiHandle` tail.
 */
export async function startOrchestrator(
	opts: OrchestratorStartOptions,
): Promise<PiHandle> {
	const provider = process.env.DILNA_PROVIDER as DilnaProvider;
	const modelId = process.env.DILNA_MODEL as string;
	const model = getBuiltinModels(provider).find((m) => m.id === modelId);
	if (!model) {
		throw new Error(
			`DILNA_PROVIDER=${provider}/DILNA_MODEL=${modelId} is no longer a valid combination`,
		);
	}

	const agent = new Agent({
		initialState: {
			systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
			model,
			tools: createOrchestratorTools(opts.deps),
			messages: opts.initialMessages,
		},
		sessionId: opts.sessionId,
		streamFn: streamSimple,
		getApiKey: (p) => getEnvApiKey(p, process.env as Record<string, string>),
	});

	return wirePiHandle(agent, opts.worktreePath);
}

/**
 * Send a single user message to the agent and resolve once the turn ends.
 * `agent.prompt()` resolves whether the turn succeeded, was provider-aborted,
 * or errored — pi's `Agent` contract encodes every failure as data on the
 * trailing assistant message rather than rejecting the call (confirmed
 * against the installed `agent.js`: a failed/aborted run produces a synthetic
 * assistant message via `handleRunFailure`, then resolves normally) — so
 * failure detection happens here, after the await, not via a catch/reject
 * branch the way `chatClaude`'s subprocess-crash path needed.
 *
 * A deliberate Stop (via `opts.abortSignal`) also lands on that same
 * `stopReason: "aborted"` trailing message, but per ADR-0016 §3 that must
 * land a clean `idle`, not a `turn_failed` — so the abort-detection flag
 * below suppresses the failure check specifically for that path, mirroring
 * `chatClaude`'s own abortHandler (which resolves without ever consulting
 * the turn-end result).
 */
export async function chatPi(
	handle: PiHandle,
	opts: AgentChatOptions,
): Promise<void> {
	if (!handle.isAlive()) {
		throw new Error("pi agent has been stopped");
	}
	if (opts.abortSignal?.aborted) {
		// Already stopped before this call ever started — nothing to prompt.
		// Mirrors chatClaude's own abortHandler, which resolves without ever
		// dispatching a message.
		return;
	}
	const { agent, listeners } = handle;
	const chatListener: Listener = (ev) => opts.onEvent(ev);
	listeners.add(chatListener);

	let deliberatelyAborted = false;
	const abortHandler = () => {
		deliberatelyAborted = true;
		agent.abort();
	};
	opts.abortSignal?.addEventListener("abort", abortHandler, { once: true });

	try {
		await agent.prompt(opts.message);
		if (!deliberatelyAborted) {
			const last = agent.state.messages.at(-1);
			if (
				last?.role === "assistant" &&
				(last.stopReason === "error" || last.stopReason === "aborted")
			) {
				opts.onEvent({
					type: "turn_failed",
					class: "turn_error",
					message: last.errorMessage
						? `pi agent error: ${last.errorMessage}`
						: `pi agent turn ended: ${last.stopReason}`,
				});
			}
		}
	} finally {
		listeners.delete(chatListener);
		if (opts.abortSignal) {
			opts.abortSignal.removeEventListener("abort", abortHandler);
		}
	}
}

// ---- Live event normalization ---------------------------------------------

export type NormalizeState = {
	/**
	 * dilna's message model expects one assistant messageId per user turn.
	 * A single `prompt()` call can span several internal tool-call rounds,
	 * each producing its own `AgentMessage` — this pins every assistant
	 * message within one turn to the same dilna id, so the live UI renders
	 * one growing message with one tool-call group instead of a separate
	 * message per round (mirrors `claude.ts`'s `currentTurnMessageId`).
	 * Reset on `agent_end`.
	 */
	currentMessageId: string | null;
	/** toolCallId -> the dilna messageId that owns it, so `tool_execution_end`
	 * (which carries no message reference of its own) can be attributed back
	 * to the right assistant message for `tool_call_end`. */
	toolCallMessageId: Map<string, string>;
	/**
	 * Running total of this turn's usage — tokens, cache tokens, reasoning
	 * tokens, and cost — summed across every internal assistant round's
	 * `message_end` (a `prompt()` call can span several — see
	 * `currentMessageId`'s doc comment). Reported as the turn-end reconciling
	 * `usage_update`'s `cumulative` field on `agent_end`.
	 * `SessionManager.accumulateSessionUsage` folds the token fields into the
	 * session's persisted lifetime total, and inserts the full totals
	 * (including cache/cost) as one `usage_events` row for the usage
	 * dashboard. Reset on `agent_end`.
	 */
	turnUsage: UsageTotals;
};

const ZERO_TURN_USAGE: UsageTotals = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	reasoningTokens: 0,
	costUsd: 0,
};

export function createNormalizeState(): NormalizeState {
	return {
		currentMessageId: null,
		toolCallMessageId: new Map(),
		turnUsage: { ...ZERO_TURN_USAGE },
	};
}

function contentBlocksToText(
	content: string | (TextContent | ImageContent)[],
): string {
	if (typeof content === "string") return content;
	return content
		.filter((c): c is TextContent => c.type === "text")
		.map((c) => c.text)
		.join("");
}

function extractUsageTotals(usage: Usage | undefined): UsageTotals | null {
	if (!usage) return null;
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		reasoningTokens: usage.reasoning ?? 0,
		costUsd: usage.cost.total,
	};
}

/**
 * Normalize one `pi-agent-core` `AgentEvent` into zero or more dilna
 * `AgentStreamEvent`s for the live view. Structurally simpler than
 * `claude.ts`'s `normalizeStreamEvent`/`normalizeAssistantMessage` pair: pi's
 * `tool_execution_start`/`tool_execution_end` events carry the tool
 * name/args/result directly (no need to parse `tool_use` content blocks out
 * of a complete message the way Claude's transcript requires), and there's no
 * `stream_event`-vs-complete-message dedup to do since `message_update`
 * deltas and the complete `message_end` payload don't both echo full text.
 */
export function normalizePiEvent(
	event: AgentEvent,
	state: NormalizeState,
): AgentStreamEvent[] {
	switch (event.type) {
		case "message_start": {
			if (event.message.role !== "assistant") return [];
			if (state.currentMessageId) return [];
			state.currentMessageId = randomUUID();
			return [
				{
					type: "message_start",
					messageId: state.currentMessageId,
					role: "assistant",
				},
			];
		}
		case "message_update": {
			if (event.message.role !== "assistant") return [];
			const messageId = state.currentMessageId;
			if (!messageId) return [];
			const e = event.assistantMessageEvent;
			if (e.type === "text_delta" && e.delta.length > 0) {
				return [{ type: "token", messageId, chunk: e.delta }];
			}
			if (e.type === "thinking_delta" && e.delta.length > 0) {
				return [{ type: "thinking", messageId, chunk: e.delta }];
			}
			return [];
		}
		case "tool_execution_start": {
			// Usually preceded by message_start (the assistant message that
			// requested the tool call), but if a tool call ever arrives first,
			// open the message here too — the same way message_start would —
			// rather than silently claiming currentMessageId and swallowing
			// message_start's own event when it does arrive a beat later.
			const opened = !state.currentMessageId;
			if (opened) state.currentMessageId = randomUUID();
			const messageId = state.currentMessageId as string;
			state.toolCallMessageId.set(event.toolCallId, messageId);
			return [
				...(opened
					? [
							{
								type: "message_start" as const,
								messageId,
								role: "assistant" as const,
							},
						]
					: []),
				{
					type: "tool_call_start",
					messageId,
					callId: event.toolCallId,
					tool: event.toolName,
					input: event.args,
				},
			];
		}
		case "tool_execution_end": {
			const messageId = state.toolCallMessageId.get(event.toolCallId);
			if (!messageId) return [];
			const result = event.result as
				| { content?: (TextContent | ImageContent)[] }
				| undefined;
			const output = contentBlocksToText(result?.content ?? []);
			return [
				{
					type: "tool_call_end",
					messageId,
					callId: event.toolCallId,
					output,
					error: event.isError ? output : undefined,
				},
			];
		}
		case "message_end": {
			if (event.message.role !== "assistant") return [];
			const usage = extractUsageTotals(event.message.usage);
			if (!usage || !state.currentMessageId) return [];
			state.turnUsage = {
				inputTokens: state.turnUsage.inputTokens + usage.inputTokens,
				outputTokens: state.turnUsage.outputTokens + usage.outputTokens,
				cacheReadTokens:
					(state.turnUsage.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
				cacheWriteTokens:
					(state.turnUsage.cacheWriteTokens ?? 0) +
					(usage.cacheWriteTokens ?? 0),
				reasoningTokens:
					(state.turnUsage.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
				costUsd: (state.turnUsage.costUsd ?? 0) + (usage.costUsd ?? 0),
			};
			return [
				{ type: "usage_update", messageId: state.currentMessageId, usage },
			];
		}
		case "agent_end": {
			// Turn-end reconciling event (mirrors claude.ts's normalizeResultMessage):
			// this turn's total usage, in `cumulative` position so
			// SessionManager.accumulateSessionUsage folds it into the session's
			// persisted lifetime total — the only place it looks for that field.
			const events: AgentStreamEvent[] =
				state.currentMessageId &&
				(state.turnUsage.inputTokens > 0 || state.turnUsage.outputTokens > 0)
					? [
							{
								type: "usage_update",
								messageId: state.currentMessageId,
								usage: state.turnUsage,
								cumulative: state.turnUsage,
							},
						]
					: [];
			state.currentMessageId = null;
			state.toolCallMessageId.clear();
			state.turnUsage = { ...ZERO_TURN_USAGE };
			return events;
		}
		default:
			return [];
	}
}

// ---- Persistence bridge ----------------------------------------------------

/**
 * Convert one turn's new transcript entries (`agent.state.messages.slice(
 * lengthBefore)`, captured by the caller — see `sessions/manager.ts`'s
 * pi-shaped `runTurn` body) into dilna `Message[]` rows. Mirrors
 * `claudeMessagesToDilna`'s merge shape (multiple internal assistant rounds
 * within one turn collapse into a single dilna `Message{role:"assistant"}`
 * row) but simpler: no transcript-uuid bookkeeping (ids are synthesized
 * directly), no task-notification special-casing (pi has no Task-tool
 * concept), and no backwards-stamping timestamp synthesis — pi's
 * `AgentMessage.timestamp` is a real wall-clock value, used directly.
 */
export function piMessagesToDilna(
	sessionId: string,
	entries: AgentMessage[],
): Message[] {
	const toolResults = new Map<string, { output: string; error?: string }>();
	for (const entry of entries) {
		if (entry.role !== "toolResult") continue;
		const output = contentBlocksToText(entry.content);
		toolResults.set(entry.toolCallId, {
			output,
			error: entry.isError ? output : undefined,
		});
	}

	const messages: Message[] = [];
	let turn: { id: string; createdAt: number; parts: MessagePart[] } | null =
		null;
	const flushTurn = () => {
		if (turn && turn.parts.length > 0) {
			messages.push({
				id: turn.id,
				sessionId,
				role: "assistant",
				parts: turn.parts,
				createdAt: turn.createdAt,
			});
		}
		turn = null;
	};

	for (const entry of entries) {
		if (entry.role === "user") {
			flushTurn();
			const text = contentBlocksToText(entry.content);
			if (text) {
				messages.push({
					id: randomUUID(),
					sessionId,
					role: "user",
					parts: [{ type: "text", text }],
					createdAt: Math.floor(entry.timestamp / 1000),
				});
			}
			continue;
		}
		if (entry.role === "assistant") {
			if (!turn) {
				turn = {
					id: randomUUID(),
					createdAt: Math.floor(entry.timestamp / 1000),
					parts: [],
				};
			}
			for (const block of entry.content) {
				if (block.type === "text") {
					if (block.text) turn.parts.push({ type: "text", text: block.text });
				} else if (block.type === "toolCall") {
					const result = toolResults.get(block.id);
					turn.parts.push({
						type: "tool_call",
						callId: block.id,
						tool: block.name,
						input: block.arguments,
						output: result?.output ?? "",
						error: result?.error,
					});
				}
				// ThinkingContent dropped — dilna already discards thinking
				// content from persisted history (see `AgentStreamEvent`'s
				// `thinking` event doc comment).
			}
		}
		// toolResult entries are folded into `toolResults` above, not
		// persisted as their own row — mirrors how tool results merge back
		// into their owning tool_call part rather than becoming a row.
	}
	flushTurn();
	return messages;
}

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Reconstruct `AgentMessage[]` from dilna's own persisted `Message[]` rows,
 * for seeding a freshly-constructed `Agent`'s `initialState.messages` on
 * every cold start (see `PiStartOptions.initialMessages`). A dilna
 * `{role:"assistant"}` row becomes one `AssistantMessage` plus one
 * `ToolResultMessage` per `tool_call` part — pi keeps tool calls and their
 * results as separate transcript entries where dilna merges them into one
 * row (the inverse of {@link piMessagesToDilna}'s merge). `usage`/
 * `stopReason`/`api` are placeholder values on replay — irrelevant once the
 * message is just prior context, not something being executed.
 */
export function dilnaMessagesToInitialState(
	messages: Message[],
): AgentMessage[] {
	const out: AgentMessage[] = [];
	for (const message of messages) {
		const timestamp = message.createdAt * 1000;
		if (message.role === "user") {
			const text = message.parts
				.filter((p) => p.type === "text")
				.map((p) => p.text)
				.join("\n");
			out.push({ role: "user", content: text, timestamp });
			continue;
		}

		const content: AssistantMessage["content"] = [];
		const toolCallParts = message.parts.filter((p) => p.type === "tool_call");
		for (const part of message.parts) {
			if (part.type === "text") {
				content.push({ type: "text", text: part.text });
			} else {
				content.push({
					type: "toolCall",
					id: part.callId,
					name: part.tool,
					arguments: (part.input as Record<string, unknown>) ?? {},
				});
			}
		}
		out.push({
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: (process.env.DILNA_PROVIDER as DilnaProvider) ?? "anthropic",
			model: process.env.DILNA_MODEL ?? "unknown",
			usage: EMPTY_USAGE,
			stopReason: "stop",
			timestamp,
		});
		for (const part of toolCallParts) {
			out.push({
				role: "toolResult",
				toolCallId: part.callId,
				toolName: part.tool,
				content: [
					{
						type: "text",
						text:
							typeof part.output === "string"
								? part.output
								: JSON.stringify(part.output ?? ""),
					},
				],
				isError: Boolean(part.error),
				timestamp,
			});
		}
	}
	return out;
}
