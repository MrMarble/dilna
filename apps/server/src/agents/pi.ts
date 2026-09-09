import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
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
	generateSummary,
} from "@earendil-works/pi-agent-core";
import type {
	Api,
	Context,
	Model,
	Models,
	SimpleStreamOptions,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	type AssistantMessage,
	completeSimple,
	type ImageContent,
	streamSimple,
	type TextContent,
	type ThinkingContent,
	type ToolCall,
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
import { logger } from "../logger";
import {
	getRepoMemory,
	REPO_MEMORY_MAX_CHARS,
	setRepoMemory,
} from "../repos/memory";
import {
	formatSkillsPrompt,
	type LoadedSkill,
	loadSkillsForRepo,
} from "../skills/loader";
import { createConfinementHook } from "./confinement";
import {
	createOrchestratorTools,
	ORCHESTRATOR_SYSTEM_PROMPT,
	type OrchestratorDeps,
} from "./orchestratorTools";
import {
	ensureWritablePathsExist,
	resolveSandboxGrant,
	type SandboxGrant,
} from "./worktreeSandbox";

export type { AgentEvent, OrchestratorDeps };

const log = logger.child({ component: "agents/pi" });

import { buildCustomModel, getCustomProvider } from "./customProviders";
import { isDilnaProvider } from "./providerConfig";
import { effectiveModel, effectiveProvider } from "./providerConfigStore";
import { resolveApiKey } from "./providerCredentials";
import type { AgentChatOptions } from "./types";
import { createWebFetchTool } from "./webFetchTool";

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
	/** The concrete provider/model this Session was created to run on (the
	 * Settings snapshot — multi-provider support), when one exists.
	 * SessionManager.startAgent resolves empty/absent values to the
	 * then-effective global config, so passing it here keeps a Session pinned
	 * to the model it started on rather than drifting if the instance default
	 * changes under it. */
	provider?: string | null;
	model?: string | null;
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
	/** The concrete provider/model this `Agent` was constructed with (from
	 * `resolveConfiguredModel`), captured at construction time so usage-event
	 * recording can attribute a turn to the model the Session *actually ran
	 * on, rather than whatever the global effective override/env happens to
	 * be at record time — the provider/model is now web-configurable and can
	 * change under a long-lived Session. */
	provider: string;
	model: string;
	/** Always empty — pi has no subprocess to capture stderr from. Kept only
	 * for shape-parity with `failTurn`'s `detail.stderrTail` field, which
	 * every `turn_failed` broadcast (Claude- or pi-sourced) fills in the same
	 * way. */
	stderrTail: string[];
};

const DILNA_AGENT_CONTEXT = `You run headless inside dilna, a self-hosted workspace that runs coding agents against cloned repos.

WORKTREE
Your cwd is a git worktree on its own branch, not the repo's main checkout. Sibling worktrees run other sessions — you don't see their uncommitted work, they don't see yours.

CONFINEMENT
Stay inside your worktree: read/write/edit/grep/find/ls and sandboxed bash are all confined to it (plus the shared git object store, so git log/commit/branch still work). A write outside that boundary fails with a clear error — that's the confinement, not a bug, and there's no bypass. Widen the actual grant or report the gap instead of working around it.

QUESTION OR TASK — decide this first
A question gets a text answer only — no file edits, no mutating bash, no commits, even when you already know the fix. Only take action when the user asks you to build, fix, add, change, or implement something. If a message is genuinely ambiguous, answer the literal question first and name the implementation as something you could do next, rather than guessing and doing it.

DURING A TASK
Once you've settled on an approach, carry it through — don't stop mid-task to ask "should I do X or Y?" But if you hit something that isn't easily fixable, or you've made more than two attempts at the same fix without success, stop and explain: what you tried, what happened, what you think is going on. Let the user weigh in instead of grinding further.

SHELL STATE
Only the shell process resets between bash calls — exported env vars, shell functions, and sourced profile state don't carry over, so re-\`export\`/re-\`source\` what a later call needs. Disk state persists, including $HOME, shared across every session this dilna instance runs. Check \`command -v <tool>\` before installing — it may already be there from earlier in this session or a previous one.

TOOLCHAIN
Nothing runtime-specific is pre-installed. Use mise (already on PATH): \`mise install\` picks up versions from the repo's own .tool-versions/.nvmrc/.python-version/mise.toml if present, or \`mise use <tool>@<version>\` to pick one yourself. Covers node, pnpm, go, python, rust, ruby, and more. Never invoke \`corepack\` yourself (enable/prepare/etc.) — mise already resolves pnpm/yarn directly; running corepack instead makes it try to download the package manager from the npm registry, which fails in a network-restricted deployment and reads like "no network" when the real fix is just \`mise install\`/\`mise exec\`.

REPO MEMORY
Before exploring an unfamiliar repo, call \`read_repo_memory\` to check for facts a previous session already saved about it (env quirks, flaky suites, generated files not to hand-edit) — every Session gets a fresh Worktree, so nothing carries over unless it was written down. Found a new one? Save it immediately with \`update_repo_memory\`.

OUTPUT STYLE
Everything you write between tool calls lands as a chat message in dilna's UI, read back asynchronously — not a terminal someone is watching live. Skip narration ("Let me check X", "Now I'll look at Y") and preamble ("Great question!", "Sure, I can help with that") — the tool call already shows the step, so start with the answer. Match length to what happened: a one-line fix gets a one-line summary. Save detail for where it's actually read afterward — a PR description, a commit message, a code comment on a non-obvious choice — not chat narration.`;

/**
 * Appended to the system prompt only when `SessionManager.create`'s
 * best-effort `codegraph init --yes` actually produced a `.codegraph/` dir
 * in this Worktree (checked in `startPi`) — never asserted unconditionally,
 * so a Session where init failed or the binary is missing doesn't get
 * pointed at a tool that isn't there. Kept to one short paragraph: pi.ts's
 * system prompt was already trimmed twice (#115, #117) for overstepping and
 * verbosity, and this shouldn't reopen that.
 */
const CODEGRAPH_SYSTEM_PROMPT_NOTE = `\n\nCODEGRAPH\nThis worktree has a codegraph index (\`.codegraph/\`, built at Session creation and kept in sync automatically). For "who calls X" / "what does X touch" questions on unfamiliar code, prefer \`codegraph explore <symbol-or-path>\` over grep — one call returns source plus callers/callees instead of several rounds of grep. Fall back to grep/read when codegraph doesn't have what you need.`;

const READ_REPO_MEMORY_TOOL_DESCRIPTION = `Read this Repo's persistent memory — short, durable facts a previous Session recorded (e.g. "tests need FOO_ENV set", "this suite is flaky on CI", "don't hand-edit the generated file, it's overwritten by build"). Scoped to the Repo, not this Worktree: every Session gets an isolated, throwaway Worktree, but memory carries over since it's scoped to the Repo. Returns an empty result if nothing has been saved yet. Call this before \`update_repo_memory\` too — that tool replaces the whole memory, so you need the current content in hand before editing it.`;

const readRepoMemorySchema = Type.Object({});

function createReadRepoMemoryTool(
	repoId: string,
): AgentTool<typeof readRepoMemorySchema> {
	return {
		name: "read_repo_memory",
		label: "Read repo memory",
		description: READ_REPO_MEMORY_TOOL_DESCRIPTION,
		parameters: readRepoMemorySchema,
		execute: async () => {
			const content = await getRepoMemory(repoId);
			return {
				content: [
					{
						type: "text" as const,
						text: content || "(no repo memory saved yet)",
					},
				],
				details: {},
			};
		},
	};
}

const UPDATE_REPO_MEMORY_TOOL_DESCRIPTION = `Replace this Repo's persistent memory with short, durable facts that should carry over to every future Session on this Repo (e.g. "tests need FOO_ENV set", "this suite is flaky on CI", "don't hand-edit the generated file, it's overwritten by build"). Every Session gets an isolated, throwaway Worktree, so without this a fact discovered in one Session is invisible to the next.

This call REPLACES the entire memory, it does not append — call \`read_repo_memory\` first to get the current content (if any), then send back the full edited text (add/edit/remove entries as needed). Pass an empty string to clear it entirely.

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

const READ_SKILL_TOOL_DESCRIPTION = `Load the full instructions for one of the skills listed under SKILLS in your system prompt. Those listings are name + description only — the actual procedure is not in your context until you call this. Pass the skill's exact name. Call it as soon as a listed skill looks relevant to the task, and follow what it says; skills are installed deliberately for this Repo, so a matching one is the intended way to do the work.`;

const readSkillSchema = Type.Object({ name: Type.String() });

/**
 * The read half of issue #60's progressive disclosure: skill bodies stay out
 * of the system prompt (which only lists name + description) until the model
 * asks for one by name. `skills` is the already-loaded set for this Session's
 * Repo, so this never re-reads disk mid-turn.
 */
function createReadSkillTool(
	skills: LoadedSkill[],
): AgentTool<typeof readSkillSchema> {
	return {
		name: "read_skill",
		label: "Read skill",
		description: READ_SKILL_TOOL_DESCRIPTION,
		parameters: readSkillSchema,
		execute: async (_toolCallId, params) => {
			if (skills.length === 0) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No skills are enabled for this Repo.",
						},
					],
					details: {},
				};
			}
			const wanted = params.name.trim().toLowerCase();
			const skill =
				skills.find((s) => s.name.toLowerCase() === wanted) ??
				skills.find((s) => s.name.toLowerCase().includes(wanted));
			if (!skill) {
				throw new Error(
					`No skill named "${params.name}". Enabled skills: ${skills
						.map((s) => s.name)
						.join(", ")}.`,
				);
			}
			// `filePath` is included because a skill's SKILL.md routinely links to
			// sibling files (`tests.md`, `agents/*.yaml`) by relative path —
			// without the absolute location the agent can't resolve those.
			return {
				content: [
					{
						type: "text" as const,
						text: `${skill.content}\n\n(Skill file: ${skill.filePath} — referenced files sit alongside it.)`,
					},
				],
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
 *
 * The policy itself is not decided here — it arrives as a
 * {@link SandboxGrant} value from `worktreeSandbox.ts` (issue #177), which
 * owns every writable path, deny-read path and toolchain env var and carries
 * the incident history behind each. This function is only the plumbing that
 * hands that data to `wrapWithSandbox` per call.
 */
function createSandboxedBashOperations(grant: SandboxGrant): BashOperations {
	const local = createLocalBashOperations();
	return {
		async exec(command, cwd, options) {
			const wrapped = await SandboxManager.wrapWithSandbox(
				command,
				undefined,
				{
					filesystem: {
						denyRead: grant.denyReadPaths,
						// Re-open the worktree (and everything it's otherwise allowed to
						// write) for reads within the broader deny — see
						// `SandboxGrant.writablePaths`' own doc comment.
						allowRead: grant.writablePaths,
						allowWrite: grant.writablePaths,
						denyWrite: [],
					},
				},
				options.signal,
			);
			return local.exec(wrapped, cwd, {
				...options,
				env: { ...options.env, ...grant.env },
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
 * Resolve a `Model` for a provider/model pair, whichever catalog the
 * provider comes from: `pi-ai`'s builtin catalog for an allowlisted provider,
 * or a stored custom provider's own model list (customProviders.ts) —
 * dilna's answer to pi's CLI-only `~/.pi/agent/models.json`. Shared by
 * {@link resolveConfiguredModel} (throws on a miss) and
 * {@link resolveSummarizationModel} (returns `undefined`), the only two
 * lookup shapes callers need.
 */
function lookupModel(
	provider: string,
	modelId: string,
): Model<Api> | undefined {
	if (isDilnaProvider(provider)) {
		return getBuiltinModels(provider).find((mm) => mm.id === modelId);
	}
	const custom = getCustomProvider(provider);
	return custom ? buildCustomModel(custom, modelId) : undefined;
}

/**
 * Resolve the concrete provider/model pi should run on for a Session.
 * Provider/model come from the session's own snapshot (the Settings-derived
 * provider/model captured when the Session was created — multi-provider
 * support, see manager.create) when one exists, else from the instance
 * override if one is set, else from `DILNA_PROVIDER`/`DILNA_MODEL` env (see
 * providerConfigStore.ts) — this is the one place every session-starting
 * call goes through. Returns the validated catalog `Model` for the active
 * combination, throwing a descriptive error if there's no usable
 * provider/model (only reachable when the override/env were changed out from
 * under a running server — the override write path and boot check validate
 * first).
 */
function resolveConfiguredModel(
	provider?: string | null,
	model?: string | null,
) {
	const p = (provider ?? effectiveProvider()).trim();
	const m = (model ?? effectiveModel()).trim();
	if (!p || !m) {
		throw new Error(
			`no usable provider/model configured (effective provider=${p || "<unset>"}, model=${m || "<unset>"}). Set DILNA_PROVIDER/DILNA_MODEL in the environment or configure one in Settings.`,
		);
	}
	const modelObj = lookupModel(p, m);
	if (!modelObj) {
		throw new Error(
			`provider=${p}/model=${m} is no longer a valid combination.`,
		);
	}
	return { provider: p, modelId: m, model: modelObj };
}

/**
 * `pi-ai`'s per-"provider" API-key resolution, but layered over dilna's own
 * stored (Settings) keys — the single place pi's `Agent` construction and the
 * summarization/archive model calls ask ``what API key am I talking to this
 * provider with?''. Stored keys win; env (`*_API_KEY`) is the fallback. See
 * providerCredentials.ts.
 */
function providerApiKey(provider: string): Promise<string | undefined> {
	return resolveApiKey(provider);
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

	const { provider, modelId, model } = resolveConfiguredModel(
		opts.provider,
		opts.model,
	);

	// Every filesystem/toolchain grant this Session's sandboxed bash runs
	// under, as one value — see worktreeSandbox.ts for the policy itself.
	const grant = resolveSandboxGrant(opts.worktreePath);

	const hasCodegraph = existsSync(path.join(opts.worktreePath, ".codegraph"));

	// Skills enabled for this Repo (issue #60). Installed globally, enabled
	// per-Repo, so a Session only ever sees the subset its own Repo turned on.
	const repoSkills = await loadSkillsForRepo(opts.repoId);

	const systemPrompt =
		DILNA_AGENT_CONTEXT +
		formatSkillsPrompt(repoSkills) +
		(grant.nestedInCheckout
			? `\n\nNote: this worktree happens to live nested inside dilna's own checkout on the host filesystem — the read/grep/find/ls tools are confined to this worktree regardless, so dilna's own project files are not reachable from here.`
			: "") +
		(hasCodegraph ? CODEGRAPH_SYSTEM_PROMPT_NOTE : "");

	// biome-ignore lint/suspicious/noExplicitAny: AgentTool<any> is the library's own alias for a type-erased tool (pi-coding-agent's `Tool` type)
	const tools: AgentTool<any>[] = [
		createReadTool(opts.worktreePath),
		createWriteTool(opts.worktreePath),
		createEditTool(opts.worktreePath),
		createGrepTool(opts.worktreePath),
		createFindTool(opts.worktreePath),
		createLsTool(opts.worktreePath),
		createBashTool(opts.worktreePath, {
			operations: createSandboxedBashOperations(grant),
		}),
		createReadRepoMemoryTool(opts.repoId),
		createUpdateRepoMemoryTool(opts.repoId),
		// Progressive disclosure (issue #60): only the enabled skills'
		// name/description are in the system prompt above; this loads one's
		// full text on demand. Registered unconditionally so the tool exists
		// even when the list is empty — it just reports nothing is installed.
		createReadSkillTool(repoSkills),
		// Runs in the server process, not sandboxed bash — no new capability
		// vs. curl-through-bash (the sandbox network policy already allows all
		// domains); see webFetchTool.ts's module doc comment and ADR-0026.
		createWebFetchTool(),
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
		getApiKey: (p) => resolveApiKey(p),
		beforeToolCall: createConfinementHook(opts.worktreePath),
	});

	return wirePiHandle(agent, opts.worktreePath, provider, modelId);
}

/**
 * The event-plumbing/lifecycle tail every `PiHandle` needs regardless of
 * which tools its `Agent` was built with — shared by `startPi` and
 * `startOrchestrator` so the two only differ in what actually varies
 * (system prompt, tool set, sandbox/confinement).
 */
function wirePiHandle(
	agent: Agent,
	worktreePath: string,
	provider: string,
	model: string,
): PiHandle {
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
		provider,
		model,
		stderrTail: [],
	};
}

export type OrchestratorStartOptions = {
	sessionId: string;
	worktreePath: string;
	/** The concrete provider/model this orchestrator Session runs on — the
	 * orchestrator meta-repo Session is created through the exact same
	 * `manager.create` path as ordinary Sessions, so it carries a Settings
	 * snapshot too (see `PiStartOptions.provider`). Empty/absent falls back
	 * to the then-effective global config, same as ordinary Sessions. */
	provider?: string | null;
	model?: string | null;
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
	const { provider, modelId, model } = resolveConfiguredModel(
		opts.provider,
		opts.model,
	);

	const agent = new Agent({
		initialState: {
			systemPrompt: ORCHESTRATOR_SYSTEM_PROMPT,
			model,
			tools: createOrchestratorTools(opts.deps),
			messages: opts.initialMessages,
		},
		sessionId: opts.sessionId,
		streamFn: streamSimple,
		getApiKey: (p) => resolveApiKey(p),
	});

	return wirePiHandle(agent, opts.worktreePath, provider, modelId);
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
	content: string | (TextContent | ImageContent | ThinkingContent | ToolCall)[],
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

/**
 * Convert one already-resolved pi-agent-core round (ADR-0026's incremental
 * persistence unit) into a single dilna `Message` row. A "round" is raw
 * pi-agent-core's own `turn_end` payload: one assistant `AgentMessage` plus
 * the `ToolResultMessage`s for every tool call it made — both already
 * pushed onto `agent.state.messages` by the time `turn_end` fires (see
 * `agent-loop.js`: the assistant message and each tool result get their own
 * `message_end` before `turn_end` is emitted), so there is nothing partial
 * here to guard against.
 *
 * Unlike `piMessagesToDilna`, which collapses every round in a whole
 * `prompt()` call into one merged row with a freshly-minted id per call,
 * this always produces at most one row, with its id minted here — safe
 * because (per `sessions/manager.ts`'s `runTurn`) each round is persisted
 * exactly once, immediately, never re-derived from a growing array on a
 * later call. Returns `null` for an empty round (no text, no tool calls —
 * mirrors `piMessagesToDilna`'s own `flushTurn` skipping empty turns), so
 * the caller knows not to insert a row.
 */
export function piRoundToDilnaMessage(
	sessionId: string,
	round: { message: AgentMessage; toolResults: ToolResultMessage[] },
): Message | null {
	if (round.message.role !== "assistant") return null;

	const toolResults = new Map<string, { output: string; error?: string }>();
	for (const result of round.toolResults) {
		const output = contentBlocksToText(result.content);
		toolResults.set(result.toolCallId, {
			output,
			error: result.isError ? output : undefined,
		});
	}

	const parts: MessagePart[] = [];
	for (const block of round.message.content) {
		if (block.type === "text") {
			if (block.text) parts.push({ type: "text", text: block.text });
		} else if (block.type === "toolCall") {
			const result = toolResults.get(block.id);
			parts.push({
				type: "tool_call",
				callId: block.id,
				tool: block.name,
				input: block.arguments,
				output: result?.output ?? "",
				error: result?.error,
			});
		}
		// ThinkingContent dropped, same as piMessagesToDilna.
	}
	if (parts.length === 0) return null;

	return {
		id: randomUUID(),
		sessionId,
		role: "assistant",
		parts,
		createdAt: Math.floor(round.message.timestamp / 1000),
	};
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
			provider: effectiveProvider() || "anthropic",
			model: effectiveModel() || "unknown",
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

// ---- Summarization support (ADR-0023 / ADR-0024) ---------------------------

/**
 * The compaction/archive *policy* lives in `sessions/context.ts` (issue
 * #175) — a cut point, a token budget and what a summary replaces are
 * Session-lifetime concerns, not adapter mechanics. What stays here is only
 * the part that genuinely needs `pi-agent-core`/`pi-ai`: resolving a catalog
 * `Model` ({@link resolveSummarizationModel}) and running the summarization
 * round-trip ({@link summarizeMessages}). Both are called *by* that module;
 * nothing here calls back into `sessions/`.
 *
 * `generateSummary`'s `models: Models` parameter only ever calls
 * `completeSimple` on it (confirmed by reading pi-agent-core's
 * `completeSimpleWithRetries`, the only place `generateSummary` touches
 * `models`) — so rather than build a full `Models` registry (provider list,
 * auth resolution, model catalogs, the way `pi-coding-agent`'s harness does)
 * this satisfies just that one method, delegating to pi-ai's bare
 * `completeSimple` function with the same API key lookup `startPi`'s `Agent`
 * construction already uses for its `streamFn`. The rest of the `Models`
 * interface (provider registry, auth, streaming) is intentionally unused,
 * hence the cast below.
 */
const summarizationModels = {
	completeSimple: async (
		model: Model<Api>,
		context: Context,
		options?: SimpleStreamOptions,
	) => {
		const apiKey = await providerApiKey(model.provider);
		return completeSimple(model, context, { ...options, apiKey });
	},
	// biome-ignore lint/suspicious/noExplicitAny: partial `Models` shim, see doc comment above
} as any as Models;

/**
 * Resolve a `Model` by the exact provider/model a Session's `Agent` was
 * constructed with (`PiHandle.provider`/`.model`), not whatever's currently
 * configured — mirrors `resolveConfiguredModel` but for a possibly-different,
 * already-running Session (the effective provider/model is web-configurable
 * and can change under a long-lived Session; see `PiHandle`'s doc comment).
 * `undefined` (rather than a throw) when the pair has fallen out of dilna's
 * catalog: `sessions/context.ts`'s callers all degrade to "can't estimate,
 * can't compact" rather than failing the Session operation in progress.
 */
export function resolveSummarizationModel(
	provider: string,
	modelId: string,
): Model<Api> | undefined {
	return lookupModel(provider, modelId);
}

/**
 * One summarization round-trip, as `sessions/context.ts`'s compaction and
 * archive paths both need it: pi-agent-core's `generateSummary` over an
 * already-converted transcript, on `model`, optionally *updating*
 * `previousSummary` rather than re-deriving from scratch.
 *
 * Flattens pi's `Result` into `string | null` so the policy module never has
 * to know pi's result shape — a failure is data, not a throw, since neither
 * caller treats it as fatal (the compaction check retries at the next turn;
 * archival deletes the Session anyway). The concrete error is logged here,
 * where it's still in its native shape.
 */
export async function summarizeMessages(opts: {
	model: Model<Api>;
	messages: AgentMessage[];
	reserveTokens: number;
	previousSummary?: string;
}): Promise<string | null> {
	const result = await generateSummary(
		opts.messages,
		summarizationModels,
		opts.model,
		opts.reserveTokens,
		undefined,
		undefined,
		opts.previousSummary,
	);
	if (!result.ok) {
		// Logged here, where the error is still in pi's native shape; both
		// callers in `sessions/context.ts` treat `null` as non-fatal and don't
		// re-log it.
		log.error(
			{
				provider: opts.model.provider,
				model: opts.model.id,
				err: result.error,
			},
			"summarization failed",
		);
		return null;
	}
	return result.value;
}

// ---- Session title derivation -----------------------------------------------

/**
 * System prompt for the tiny, isolated title-derivation call that gives a
 * Session a meaningful title from its first prompt. The retired Claude
 * backend auto-derived a title from its own transcript summary; pi has no
 * such equivalent (no CLI, no transcript summary — see ADR-0020), so instead
 * of letting the framework keep a generic placeholder indefinitely we ask the
 * pi agent itself (the same model/provider the Session runs on) a minimal
 * question. Kept deliberately small and deterministic in what it asks for so
 * the response is a single usable line rather than an essay.
 */
const TITLE_SYSTEM_PROMPT =
	"You produce short session titles for dilna, a self-hosted workspace that " +
	"runs AI coding agents against cloned repos. A user just started a new " +
	"Session with a single first prompt. Write a concise, meaningful title for " +
	"that Session: 3-4 words max, describing what the work is about — do not " +
	"restate the prompt verbatim. Reply with ONLY the title: no quotes, no " +
	"punctuation, no leading/trailing whitespace, no explanation.";

/**
 * Derive a short title for a Session by asking the pi agent itself (a fresh,
 * throwaway `Agent` on the Session's own provider/model — same class and
 * config `startPi` uses) to summarise the user's first prompt.
 *
 * Deliberately built as its OWN `Agent` instance rather than calling the
 * Session's live `PiHandle.agent`:
 *
 * - **No transcript pollution.** The title prompt+response would otherwise land
 *   in the Session's `agent.state.messages` and get persisted by
 *   `persistMessagesFromAgent`'s slice as if it were real chat, and it would be
 *   broadcast over the Session's SSE stream as a second, user-unasked turn. A
 *   throwaway `Agent` with its own empty history never touches either.
 * - **No working filesystem needed.** It carries no tools and no system prompt
 *   beyond `TITLE_SYSTEM_PROMPT`, so it needs no `SandboxManager`, no
 *   confinement hook, and no toolchain grants — just a bare model round-trip.
 *
 * Best-effort: any failure (no model configured, a provider error, a non-
 * assistant reply) resolves `null`, which the caller treats as "keep the
 * current title". Never rejects.
 */
export async function generateSessionTitle(
	sessionId: string,
	userPrompt: string,
	provider?: string | null,
	modelId?: string | null,
): Promise<string | null> {
	let resolved = resolveConfiguredModel();
	try {
		resolved = resolveConfiguredModel(provider, modelId);
	} catch {
		try {
			resolved = resolveConfiguredModel();
		} catch {
			// No usable provider/model anywhere (nothing pinned to the Session and
			// no override/env default) — best-effort per the doc comment: keep the
			// placeholder title.
			return null;
		}
	}
	const model = resolved.model;

	// Title derivation carries no tools — just the bare model call described in
	// the doc comment above. Uses the same explicit `AgentTool<any>` alias
	// `startPi` relies on (pi-coding-agent's type-erased `Tool` type), here
	// empty; annotated to keep the inference to `never[]` from drilling into the
	// `Agent` constructor's tool parameter type.
	// biome-ignore lint/suspicious/noExplicitAny: AgentTool<any> matches startPi.
	const tools: AgentTool<any>[] = [];

	const titleAgent = new Agent({
		initialState: {
			systemPrompt: TITLE_SYSTEM_PROMPT,
			model,
			tools,
			messages: [],
		},
		// A distinct `sessionId` for the provider's cache-affinity hint so this
		// tiny call never collides with the real Session's billing/cache bucket.
		sessionId: `${sessionId}:title`,
		streamFn: streamSimple,
		getApiKey: (p) => providerApiKey(p),
	});

	await titleAgent.prompt(
		`The user's first prompt:\n\n"""\n${userPrompt}\n"""\n\nWrite the Session title now.`,
	);

	const last = titleAgent.state.messages.at(-1);
	if (last?.role !== "assistant") return null;
	// Don't trust the model to have obeyed "no quotes": strip enclosing
	// quotes/curly quotes in case it wrapped the title anyway.
	return extractTitleFromReply(contentBlocksToText(last.content));
}

/**
 * Parse a Session title out of the title-generating agent's reply. Pure and
 * exported so the parsing is unit-testable without constructing a real
 * provider-backed `Agent` — `generateSessionTitle` is the only caller.
 * Trims whitespace, strips enclosing single/double/curly quotes, and drops
 * an empty result to `null` ("no title produced").
 */
export function extractTitleFromReply(reply: string): string | null {
	const title = reply.trim().replace(/^["'“”]+|["'“”]+$/g, "");
	return title || null;
}
