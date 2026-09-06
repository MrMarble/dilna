import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	getDefaultWritePaths,
	SandboxManager,
} from "@anthropic-ai/sandbox-runtime";
import type {
	AgentStreamEvent,
	ContextUsageEstimate,
	Message,
	MessagePart,
	UsageTotals,
} from "@dilna/shared";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	generateSummary,
	shouldCompact,
} from "@earendil-works/pi-agent-core";
import type {
	Api,
	Context,
	Model,
	Models,
	SimpleStreamOptions,
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

import { isDilnaProvider } from "./providerConfig";
import { effectiveModel, effectiveProvider } from "./providerConfigStore";
import { resolveApiKey } from "./providerCredentials";
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
// NOT redirected here on purpose: `PI_CODING_AGENT_DIR` (where
// pi-coding-agent's grep/find tools self-download rg/fd if neither is on
// PATH, per those tools' own `getBinDir()`) can't go through `toolchainEnv()`
// below like the vars above do. `toolchainEnv()` only reaches the sandboxed
// bash tool's own subprocess — a different process from this server, which
// is what actually runs grep/find — and pi-coding-agent's `tools-manager.js`
// caches its resolved bin dir as a module-level constant read once at import
// time, before any of this file's own code (`toolchainEnv()` included) ever
// runs. It has to be a real env var on the server process itself before
// `node` starts: set in `docker-entrypoint.sh` (derived from
// `DILNA_DATA_DIR`, mirroring `TOOLCHAIN_HOME` here). Not set for local dev
// (no `mise.toml` `[env]` entry) — `pnpm --filter @dilna/server run dev`
// runs with cwd `apps/server/`, not the repo root `getDataDir()` resolves
// relative `DILNA_DATA_DIR` values against, and pi-coding-agent's own path
// normalizer has no equivalent repo-root-walking logic, so a naive relative
// value here would land in the wrong place; local dev's plain `$HOME`
// doesn't need the redirect anyway; it only vanishes on a *pod* restart.

/**
 * Own scratch parent for ad-hoc temp-file use (a one-off script, `mktemp`,
 * etc.) when a bash call happens to run with the sandbox disabled — mirrors
 * `claude.ts`'s identical `CLI_SCRATCH_PARENT_DIR`. Irrelevant to the
 * sandboxed path below: bwrap's own `--setenv TMPDIR ...` (baked into the
 * wrapped command by `sandbox-runtime` itself, from its
 * `CLAUDE_CODE_TMPDIR`/`CLAUDE_TMPDIR` env var or else its hardcoded
 * `/tmp/claude` default — see `generateProxyEnvVars` in the installed
 * `sandbox-utils.js`) always wins over whatever `TMPDIR` this process's own
 * env carries, so setting it here only helps the non-sandboxed fallback.
 */
const CLI_SCRATCH_PARENT_DIR = path.join(
	os.tmpdir(),
	`claude-${process.getuid?.() ?? 0}`,
);

/**
 * `sandbox-runtime`'s own default write-path allowlist (`getDefaultWritePaths()`,
 * e.g. `/tmp/claude`) is what it points `TMPDIR` at *inside* every sandboxed
 * command via bwrap's `--setenv` — but it never creates that directory on
 * the host itself, and bwrap silently skips binding a write path whose host
 * source doesn't exist (confirmed in the installed
 * `linux-sandbox-utils.js`'s write-path loop). Since nothing else in dilna
 * ever creates `/tmp/claude` either, every sandboxed command inherits a
 * `TMPDIR` that resolves to a nonexistent, unwritable path — and any tool
 * that touches `$TMPDIR` at startup (pnpm's `temp-dir` package `lstat`s it
 * before anything else runs) fails outright with an `ENOENT`/`EROFS` that
 * reads nothing like a temp-dir problem. This dropped out when `claude.ts`
 * (which had the equivalent gap for its own `CLAUDE_SCRATCH_WRITABLE_PATHS`,
 * a *different* directory than sandbox-runtime's own default) was replaced
 * by `pi.ts` and broke `pnpm install` for every session needing to install
 * dependencies (issue debugged 2026-08-28: three orchestrator sessions all
 * hit this via pnpm and misdiagnosed it as "no network"). Pre-creating
 * sandbox-runtime's own default paths here — rather than trying to redirect
 * `TMPDIR` — is what actually reaches the sandboxed child, since it's the
 * exact path bwrap already binds writable and points `TMPDIR` at with no
 * further config needed.
 */
const SANDBOX_DEFAULT_WRITE_PATHS = getDefaultWritePaths();

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
	CLI_SCRATCH_PARENT_DIR,
];

/** A writable-path grant only does anything once the host directory already
 * exists (see `claude.ts`'s identical note) — pre-create every leaf before
 * the sandboxed bash tool's first use. Sandbox-runtime's own default write
 * paths are included too (see `SANDBOX_DEFAULT_WRITE_PATHS`'s doc comment);
 * a leaf irrelevant to this platform (e.g. `/private/tmp/claude` on Linux)
 * fails harmlessly and is skipped rather than aborting the others. */
function ensureWritablePathsExist(): void {
	for (const dir of [
		...TOOLCHAIN_WRITABLE_PATHS,
		...SANDBOX_DEFAULT_WRITE_PATHS,
	]) {
		try {
			mkdirSync(dir, { recursive: true });
		} catch {}
	}
}

/** Toolchain env vars injected into every sandboxed bash call — see
 * `claude.ts`'s identical env block for why each one is needed.
 *
 * `PATH`: the Dockerfile bakes `/home/node/.local/share/mise/shims` onto
 * `PATH` (ADR-0012's "shim-based activation"), but that's mise's *default*
 * shims dir under plain `$HOME` — dead since issue #83 redirected
 * `MISE_DATA_DIR` (and therefore mise's real shims dir) to
 * `TOOLCHAIN_HOME`/`DILNA_DATA_DIR` instead, a gap `MISE_DATA_DIR`'s own doc
 * comment above already flagged as unconfirmed. It's real: with no shims dir
 * for the *actual* `MISE_DATA_DIR` ever on `PATH`, a bare `pnpm`/`node`/etc.
 * resolves to nothing (`command not found`), pushing agents onto `mise exec
 * -- pnpm ...` — which itself doesn't reliably pick the mise-installed
 * binary either; observed live falling through to the *base* node install's
 * bundled corepack shim instead (`installs/node/<version>/lib/node_modules/corepack`),
 * which then tries to download pnpm from registry.npmjs.org and fails in a
 * network-restricted deployment. Prepending the real shims dir here is the
 * fix `mkdir -p`-side (`ensureWritablePathsExist` below creates the dir mise
 * populates once a tool's `mise install` has actually run); it also sorts
 * ahead of the corepack-shimmed `pnpm` in the mise-installed node's own bin
 * dir, so once a real shim exists here it wins PATH resolution instead of
 * corepack's.
 */
function toolchainEnv(worktreePath: string): NodeJS.ProcessEnv {
	return {
		MISE_TRUSTED_CONFIG_PATHS: [
			process.env.MISE_TRUSTED_CONFIG_PATHS,
			worktreePath,
		]
			.filter(Boolean)
			.join(":"),
		PATH: [path.join(MISE_DATA_DIR, "shims"), process.env.PATH]
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
		// Only takes effect when a bash call runs with the sandbox disabled —
		// see CLI_SCRATCH_PARENT_DIR's doc comment for why the sandboxed path
		// needs a different fix (SANDBOX_DEFAULT_WRITE_PATHS).
		TMPDIR: process.env.TMPDIR ?? CLI_SCRATCH_PARENT_DIR,
	};
}

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
	if (!isDilnaProvider(p) || !m) {
		throw new Error(
			`no usable provider/model configured (effective provider=${p || "<unset>"}, model=${m || "<unset>"}). Set DILNA_PROVIDER/DILNA_MODEL in the environment or configure one in Settings.`,
		);
	}
	const modelObj = getBuiltinModels(p).find((mm) => mm.id === m);
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

	const gitCommonDir = resolveGitCommonDir(opts.worktreePath);
	const workspaceRoot = findWorkspaceRoot(__dirname);
	const dataDir = getDataDir();
	const nestedInCheckout = dataDir.startsWith(`${workspaceRoot}${path.sep}`);

	const hasCodegraph = existsSync(path.join(opts.worktreePath, ".codegraph"));

	const systemPrompt =
		DILNA_AGENT_CONTEXT +
		(nestedInCheckout
			? `\n\nNote: this worktree happens to live nested inside dilna's own checkout on the host filesystem — the read/grep/find/ls tools are confined to this worktree regardless, so dilna's own project files are not reachable from here.`
			: "") +
		(hasCodegraph ? CODEGRAPH_SYSTEM_PROMPT_NOTE : "");

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
		createReadRepoMemoryTool(opts.repoId),
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

// ---- Compaction (ADR-0023) --------------------------------------------------

/**
 * Prefix wrapped around a compaction summary before it's seeded as the
 * leading message of a Session's context — framed as prior context rather
 * than a fresh instruction, since it stands in for everything up to
 * `compactedThroughMessageId` rather than something the user just said.
 */
const COMPACTION_SUMMARY_PREFACE =
	"The following is a summary of earlier conversation history that was " +
	"compacted to stay within the model's context window. Treat it as prior " +
	"context, not a new instruction:\n\n";

/**
 * `generateSummary`'s `models: Models` parameter only ever calls
 * `completeSimple` on it (confirmed by reading pi-agent-core's
 * `completeSimpleWithRetries`, the only place `generateSummary` touches
 * `models`) — so rather than build a full `Models` registry (provider list,
 * auth resolution, model catalogs, the way `pi-coding-agent`'s harness does)
 * this satisfies just that one method, delegating to pi-ai's bare
 * `completeSimple` function with the same env-var API key lookup `startPi`'s
 * `Agent` construction already uses for its `streamFn`. Only `completeSimple`
 * is ever called on the result (see doc comment above) — the rest of the
 * `Models` interface (provider registry, auth, streaming) is intentionally
 * unused, hence the cast below.
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
 */
function resolveModelById(provider: string, modelId: string) {
	if (!isDilnaProvider(provider)) return undefined;
	return getBuiltinModels(provider).find((m) => m.id === modelId);
}

/**
 * Walk dilna's own message rows backward from the end, accumulating each
 * one's estimated token size (its own `dilnaMessagesToInitialState`
 * expansion, summed via pi-agent-core's `estimateTokens`) until
 * `keepRecentTokens` is reached. dilna's rows are already turn-granular —
 * one row per user/assistant turn, with any tool calls merged in (the
 * inverse of pi's per-tool-call transcript entries, see
 * `dilnaMessagesToInitialState`'s doc comment) — so this doubles as
 * pi-agent-core's own `findCutPoint` "snap to a turn boundary" requirement,
 * without needing pi's `Entry[]` session-log wrapper this function's inputs
 * never had in the first place.
 *
 * Returns the index of the first message to keep verbatim; everything
 * before it is the summarization candidate.
 */
export function pickCutPoint(
	history: Message[],
	keepRecentTokens: number,
): number {
	let kept = 0;
	let index = history.length;
	for (let i = history.length - 1; i >= 0; i--) {
		const size = dilnaMessagesToInitialState([history[i] as Message]).reduce(
			(sum, m) => sum + estimateTokens(m),
			0,
		);
		if (kept > 0 && kept + size > keepRecentTokens) break;
		kept += size;
		index = i;
	}
	return index;
}

/** A Session's persisted compaction state ({@link sessions.compactedSummary}/
 * `.compactedThroughMessageId}), or `null` for a Session never compacted. */
export type SessionCompaction = {
	summary: string;
	throughMessageId: string;
} | null;

/**
 * Build a fresh `Agent`'s `initialState.messages` from dilna's own message
 * history, folding in a stored compaction when one exists — shared by every
 * cold start (`SessionManager.startAgent`) and by
 * {@link checkSessionContext}'s own live-state rewrite, so both paths
 * produce identical context for the same `(history, compaction)` pair.
 */
export function buildInitialMessages(
	history: Message[],
	compaction: SessionCompaction,
): AgentMessage[] {
	if (!compaction) return dilnaMessagesToInitialState(history);

	const cutIndex = history.findIndex(
		(m) => m.id === compaction.throughMessageId,
	);
	// A stale/missing pointer (shouldn't happen — messages are never deleted
	// outside of session delete) degrades to the full raw history rather than
	// silently dropping context.
	const tail = cutIndex === -1 ? history : history.slice(cutIndex + 1);

	const summaryMessage: AgentMessage = {
		role: "user",
		content: COMPACTION_SUMMARY_PREFACE + compaction.summary,
		timestamp: Date.now(),
	};
	return [summaryMessage, ...dilnaMessagesToInitialState(tail)];
}

/**
 * Estimate against `model`'s window, folding in `compaction` the same way
 * {@link buildInitialMessages} would seed a fresh `Agent` — so the number
 * reported always matches what the model actually sees, not dilna's raw
 * (never-shrinking) `messages` history.
 */
function estimateFor(
	model: NonNullable<ReturnType<typeof resolveModelById>>,
	history: Message[],
	compaction: SessionCompaction,
): ContextUsageEstimate {
	return {
		tokens: estimateContextTokens(buildInitialMessages(history, compaction))
			.tokens,
		contextWindow: model.contextWindow,
		reserveTokens: DEFAULT_COMPACTION_SETTINGS.reserveTokens,
	};
}

/**
 * Same estimate as {@link checkSessionContext} computes, for a Session with
 * no live `Agent` (idle, never started, or respawned since) — used by
 * `GET /api/sessions/:id` so a page load/session switch shows the last-known
 * occupancy immediately, instead of the sidebar meter staying blank until
 * the Session's next turn (see `context_usage`'s doc comment in
 * packages/shared/src/events.ts). `provider`/`modelId` should be the
 * Session's live `PiHandle`'s captured values when one exists, or the
 * currently-effective config otherwise (the same resolution `startAgent`
 * would use if the Session resumed right now — see `PiHandle`'s doc comment
 * on why this can drift from what a still-running Session actually used).
 */
export function estimateSessionContext(
	provider: string,
	modelId: string,
	history: Message[],
	compaction: SessionCompaction,
): ContextUsageEstimate | null {
	const model = resolveModelById(provider, modelId);
	return model ? estimateFor(model, history, compaction) : null;
}

export type SessionContextCheck = {
	/** `null` only when the Session's provider/model is no longer in dilna's
	 * catalog (see `resolveModelById`) — nothing to report or compact
	 * against. */
	estimate: ContextUsageEstimate | null;
	compaction: SessionCompaction;
};

/**
 * Run after a turn's messages are already durably persisted
 * (`SessionManager.persistMessagesFromAgent`) — estimates how much of the
 * live `Agent`'s context window is occupied (against `priorCompaction`, the
 * Session's already-stored compaction if any — estimating against raw
 * history instead would ignore that the live `Agent`'s actual context is
 * already the smaller, summarized one, and re-trigger compaction on
 * essentially every subsequent turn) and, once that crosses the budget
 * threshold, summarizes everything since `priorCompaction`'s cutoff but the
 * most recent `keepRecentTokens` worth of turns, mutating
 * `handle.agent.state.messages` in place so the *current* Session's context
 * shrinks immediately rather than only on its next cold start.
 *
 * A second (or later) compaction passes `priorCompaction.summary` to
 * `generateSummary` as its `previousSummary` — an *update* to the existing
 * summary covering only what's newly being folded in, not a from-scratch
 * re-summarization of everything before the new cutoff.
 *
 * Always returns an `estimate` (for the caller to broadcast as
 * `context_usage`, ADR-0023's addendum on UI visibility) alongside a
 * `compaction` to persist onto the `sessions` row — `compaction` is `null`
 * when compaction wasn't due, or when the summarization call failed (not
 * fatal to the turn that just completed; simply retried at the next turn's
 * check).
 */
export async function checkSessionContext(
	handle: PiHandle,
	history: Message[],
	priorCompaction: SessionCompaction,
): Promise<SessionContextCheck> {
	const model = resolveModelById(handle.provider, handle.model);
	if (!model) return { estimate: null, compaction: null };

	const estimate = estimateFor(model, history, priorCompaction);
	const notDue: SessionContextCheck = { estimate, compaction: null };
	if (
		!shouldCompact(
			estimate.tokens,
			estimate.contextWindow,
			DEFAULT_COMPACTION_SETTINGS,
		)
	) {
		return notDue;
	}

	const cutFrom = priorCompaction
		? Math.max(
				0,
				history.findIndex((m) => m.id === priorCompaction.throughMessageId) + 1,
			)
		: 0;
	const tailHistory = history.slice(cutFrom);

	const cutIndexInTail = pickCutPoint(
		tailHistory,
		DEFAULT_COMPACTION_SETTINGS.keepRecentTokens,
	);
	if (cutIndexInTail <= 0) return notDue;

	const newlySummarized = tailHistory.slice(0, cutIndexInTail);
	const result = await generateSummary(
		dilnaMessagesToInitialState(newlySummarized),
		summarizationModels,
		model,
		estimate.reserveTokens,
		undefined,
		undefined,
		priorCompaction?.summary,
	);
	if (!result.ok) {
		console.error(
			`[pi] compaction summarization failed for session ${handle.worktreePath}: ${result.error instanceof Error ? result.error.message : String(result.error)}`,
		);
		return notDue;
	}

	const compaction: SessionCompaction = {
		summary: result.value,
		// Safe: `cutIndexInTail > 0` was checked above, so `newlySummarized` is
		// non-empty.
		throughMessageId: (newlySummarized.at(-1) as Message).id,
	};
	const newMessages = buildInitialMessages(history, compaction);
	handle.agent.state.messages = newMessages;

	// Report the *post*-compaction occupancy, not the stale pre-compaction
	// number that triggered this — the whole point of compacting was to
	// bring it back down.
	return {
		estimate: {
			tokens: estimateContextTokens(newMessages).tokens,
			contextWindow: estimate.contextWindow,
			reserveTokens: estimate.reserveTokens,
		},
		compaction,
	};
}

/**
 * Final summary for a Session about to be deleted (ADR-0024) — reuses the
 * same `generateSummary` call `checkSessionContext` makes, but produces one
 * summary covering the *entire* Session (no retained tail: there's no live
 * `Agent` left to keep serving one to). If the Session already has a stored
 * compaction, only the tail after its cutoff needs summarizing, passed as
 * `previousSummary` (an update, not a from-scratch re-summarization) — or,
 * if nothing happened since that cutoff, the existing summary is returned
 * verbatim with no LLM call at all. Returns `null` when there's nothing to
 * archive (`history` empty) or the provider/model can no longer be resolved;
 * the caller treats both as "skip archiving, delete anyway."
 */
export async function summarizeSessionForArchive(
	provider: string,
	modelId: string,
	history: Message[],
	priorCompaction: SessionCompaction,
): Promise<string | null> {
	if (history.length === 0) return null;
	const model = resolveModelById(provider, modelId);
	if (!model) return null;

	const cutFrom = priorCompaction
		? Math.max(
				0,
				history.findIndex((m) => m.id === priorCompaction.throughMessageId) + 1,
			)
		: 0;
	const tailHistory = history.slice(cutFrom);
	if (tailHistory.length === 0) return priorCompaction?.summary ?? null;

	const result = await generateSummary(
		dilnaMessagesToInitialState(tailHistory),
		summarizationModels,
		model,
		DEFAULT_COMPACTION_SETTINGS.reserveTokens,
		undefined,
		undefined,
		priorCompaction?.summary,
	);
	if (!result.ok) {
		console.error(
			`[pi] archive summarization failed: ${result.error instanceof Error ? result.error.message : String(result.error)}`,
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
