import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as setTimeoutAsync } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	type ApiKeySource,
	type Query,
	query,
	type SDKAPIRetryMessage,
	type SDKAssistantMessage,
	type SDKMessage,
	type SDKModelRefusalFallbackMessage,
	type SDKPartialAssistantMessage,
	type SDKRateLimitInfo,
	type SDKResultMessage,
	type SDKStatusMessage,
	type SDKTaskNotificationMessage,
	type SDKTaskProgressMessage,
	type SDKTaskStartedMessage,
	type SDKTaskUpdatedMessage,
	type SDKThinkingTokensMessage,
	type SDKToolProgressMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentStreamEvent, UsageTotals } from "@dilna/shared";
import { getDataDir } from "../db";
import type { AgentChatOptions, AgentStartOptions } from "./types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * A git worktree's `.git` is a *file* (not a directory) pointing at its own
 * metadata directory (HEAD, index, refs, logs) under the origin repo's git
 * dir. That metadata dir's own `commondir` file in turn points at the
 * *shared* git dir (objects, refs, config) — normally `../..`, i.e. the bare
 * repo root itself. ADR-0010 assumed the native sandbox (see
 * {@link startClaude}) auto-detects a linked worktree's `cwd` and grants the
 * shared dir write access on its own; live dilna sessions (worktrees under
 * `DILNA_DATA_DIR`, backed by a bare repo elsewhere entirely rather than a
 * conventional sibling `.git`) show that auto-detection doesn't fire —
 * `git commit`/`git branch` fail with "Read-only file system" against both
 * the per-worktree git-dir and the shared dir. So this is used to add the
 * shared dir to both `filesystem.allowWrite` (so agents can actually commit)
 * and `filesystem.allowRead` (when `denyRead` would otherwise cover it —
 * e.g. `git log`/`git diff` need to read historical objects from the shared
 * store) ourselves. Granting the shared dir also covers the per-worktree
 * git-dir itself, since `.git/worktrees/<name>` is nested inside it.
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

/**
 * Walk up from `start` to find dilna's own monorepo root (marked by
 * `pnpm-workspace.yaml`). Used to detect whether `DILNA_DATA_DIR` (and thus
 * every worktree) lives nested inside dilna's own checkout — the condition
 * under which a sandboxed agent's default project-memory discovery would
 * otherwise pick up dilna's own `CLAUDE.md` while working on someone else's
 * repo (see {@link startClaude}'s `claudeMdExcludes`/`denyRead` setup).
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

// The Claude Agent SDK's types are large and unstable in shape; we import
// only the ones we use here and treat message content blocks as opaque
// `Record<string, unknown>`.
type ContentBlock = Record<string, unknown> & { type?: string };

export type Listener = (event: AgentStreamEvent) => void;

/**
 * `startClaude` options extended with a callback for account-wide rate-limit
 * updates. Kept separate from the shared `AgentStartOptions` (used by the
 * generic `Agent` interface in `agents/types.ts`) rather than added to it:
 * rate limits are a Claude-Agent-SDK-specific concept (`SDKRateLimitEvent`),
 * and per ADR-0006 `AgentStreamEvent` is deliberately per-session-only, so
 * this data is forwarded out-of-band instead of being contorted into either
 * shared union — see `SessionManager.ensureStarted`/`handleRateLimitEvent`
 * for the consumer side.
 */
export type ClaudeStartOptions = AgentStartOptions & {
	onRateLimit?: (info: SDKRateLimitInfo) => void;
	/**
	 * Fired when the first turn's `system init` message reports the Claude-side
	 * session id — the only key back into the transcript. SessionManager
	 * persists it here rather than at turn end so a turn interrupted mid-way
	 * (server restart, crash) still leaves a resumable id behind (ADR-0014);
	 * waiting for turn end permanently orphaned the transcript of any session
	 * whose *first* turn was interrupted.
	 */
	onInit?: (agentSessionId: string) => void;
};

export type ClaudeHandle = {
	kind: "claude";
	/**
	 * The Claude-side session id. Empty until the first turn's `system init`
	 * message arrives (see {@link startClaude}), so this is a getter over
	 * live state rather than a value snapshotted at handle-creation time.
	 */
	readonly agentSessionId: string;
	/**
	 * Auth mode from the first turn's `system init` message. `null` until
	 * `init` arrives (see {@link agentSessionId}'s doc comment for why this
	 * is a getter). Informational only — not used to gate rate-limit
	 * forwarding (see {@link startClaude}'s handling of `rate_limit_event`
	 * for why): observed runtime values include `"none"` for a real
	 * claude.ai subscription session, which isn't even in the SDK's own
	 * documented `ApiKeySource` union, so string-matching `'oauth'` here
	 * silently dropped legitimate rate-limit data.
	 */
	readonly apiKeySource: ApiKeySource | null;
	/**
	 * Transcript uuid of the most recent complete SDKAssistantMessage seen on
	 * this handle. This — not the normalized live `messageId` — is what shows
	 * up as an entry uuid in `getSessionMessages` output: with
	 * `includePartialMessages` the live turn id is the first *stream event's*
	 * uuid, which never appears in the transcript at all, so gating the
	 * post-turn transcript sync on it spun through the whole retry ladder on
	 * every turn (observed live: expected `114fb9fc…` while the transcript
	 * held `aba59dda…`). See SessionManager.fetchClaudeMessagesWithRetry.
	 */
	readonly lastAssistantTranscriptUuid: string | undefined;
	worktreePath: string;
	listeners: Set<Listener>;
	/**
	 * Fired once, internally, when the underlying process exits unexpectedly
	 * (never on a deliberate `stop()`) — process-crash is not a subscriber-facing
	 * `AgentStreamEvent` (ADR-0016 deleted `agent_crashed` from that union), so
	 * this is a separate notification channel rather than a fake event pushed
	 * through `listeners`. `chatClaude` and `SessionManager`'s crash handler
	 * both subscribe here instead of pattern-matching on a broadcast event.
	 */
	exitListeners: Set<
		(info: { exitCode: number; stderrTail: string[] }) => void
	>;
	/**
	 * Fired once per turn when it ends (the SDK's `result` message parsed, or
	 * `stop()`'s synthetic unstick for a deliberately-interrupted turn) —
	 * whether the turn succeeded or ended in a `turn_failed` broadcast either
	 * way. Turn completion is not itself a subscriber-facing event (only
	 * `SessionManager` may emit `session_status`, per ADR-0016 §1), so
	 * `chatClaude` resolves off this instead of watching for a status event on
	 * `listeners`.
	 */
	turnEndListeners: Set<() => void>;
	stop: () => Promise<void>;
	isAlive: () => boolean;
	stderrTail: string[];
	query: Query;
	/** Pushes a user turn onto the query's streaming-input prompt. */
	sendUserMessage: (text: string) => void;
};

export type NormalizeState = {
	seenMessageStarts: Set<string>;
	/** tool_use callId -> the assistant messageId that emitted it, so the
	 * paired tool_result (delivered in a later synthetic user message) can
	 * be attributed back to the same message for tool_call_end. */
	toolMessageIds: Map<string, string>;
	/**
	 * dilna's message model expects one assistant messageId per user turn.
	 * Claude's transcript instead starts a brand new SDKAssistantMessage — a
	 * new uuid — after every tool round-trip. This pins every assistant
	 * message within one turn to the *first* uuid seen,
	 * so the live UI renders one growing message with one tool-call group
	 * instead of a separate single-tool-call message per round. Reset to
	 * null on `result` (end of turn) so the next turn gets its own id.
	 */
	currentTurnMessageId: string | null;
	/**
	 * Anthropic API message ids (`msg_…`) whose text already streamed out as
	 * `token` events via partial-message deltas. With `includePartialMessages`
	 * the SDK delivers each assistant message twice — first as
	 * `stream_event` deltas, then as the complete `SDKAssistantMessage` — so
	 * the complete message's text blocks must be skipped for ids in this set
	 * or every reply would render doubled. Text-only: tool_use blocks, usage,
	 * and errors are still taken from the complete message (tool input arrives
	 * in deltas as partial JSON, unusable until complete). Cleared on `result`
	 * to keep the set bounded per turn.
	 */
	streamedTextApiMessageIds: Set<string>;
	/**
	 * The `turn_activity` aggregate this adapter maintains for the in-flight
	 * turn (ADR-0016 §5), fed by the SDK's `status`/`api_retry`/
	 * `tool_progress`/`task_*`/`thinking_tokens` messages and re-emitted
	 * (see `activityEvent`) whenever one of them is processed — each is
	 * itself a discrete-change trigger, so no separate diffing is needed.
	 * Reset on `result` (end of turn).
	 */
	activity: {
		phase: TurnActivityPhase;
		runningTools: Map<string, { tool: string; startedAt: number }>;
		tasks: Map<
			string,
			{
				description: string;
				lastTool: string;
				toolUses: number;
				startedAt: number;
				toolUseId?: string;
			}
		>;
		thinkingTokens: number | undefined;
	};
};

type TurnActivityPhase = Extract<
	AgentStreamEvent,
	{ type: "turn_activity" }
>["phase"];

// Exported alongside NormalizeState so claude.test.ts can build a fresh
// state for normalizeMessage without duplicating its shape.
export function createNormalizeState(): NormalizeState {
	return {
		seenMessageStarts: new Set(),
		toolMessageIds: new Map(),
		currentTurnMessageId: null,
		streamedTextApiMessageIds: new Set(),
		activity: {
			phase: null,
			runningTools: new Map(),
			tasks: new Map(),
			thinkingTokens: undefined,
		},
	};
}

/**
 * dilna's own writable scratch paths for the Claude CLI — its cache,
 * transcript storage, and session-env directory, not project files. Folded
 * into the native sandbox's `filesystem.allowWrite` alongside the worktree's
 * shared git dir (see {@link startClaude}). The transcript/session-env paths
 * live under `CLAUDE_CONFIG_DIR`, not `~/.claude` directly — db/index.ts
 * redirects that env var into `DILNA_DATA_DIR` (the one persistent volume in
 * the reference deployment) as a side effect of its own import, which this
 * module's `../db` import transitively triggers before this constant is
 * evaluated. `getSessionMessages`/`getSessionInfo` in sessions/manager.ts
 * read from the same place after every turn; without this grant persisted
 * history and title auto-sync silently stay empty. `/tmp/claude-<uid>` is
 * the CLI's own per-invocation scratch dir, named after the (sanitized)
 * worktree path plus a random suffix it picks itself — ungrantable at the
 * exact leaf, so the whole per-uid parent is granted instead.
 */
export const CLAUDE_HOME =
	process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
/**
 * The CLI's own per-invocation scratch dir lives one level deeper than this
 * (named after the sanitized worktree path plus a random suffix it picks
 * itself), so only this parent is grantable/known ahead of time — see
 * {@link CLAUDE_SCRATCH_WRITABLE_PATHS}'s doc comment. Reused below as the
 * explicit `TMPDIR` handed to every session's subprocess env: it's already
 * writable, so any ad-hoc `mktemp`/tempfile use lands here instead of
 * silently falling back to an unset-`TMPDIR` default (see that env
 * assignment's comment in {@link startClaude}).
 */
const CLI_SCRATCH_PARENT_DIR = path.join(
	os.tmpdir(),
	`claude-${process.getuid?.() ?? 0}`,
);
const CLAUDE_SCRATCH_WRITABLE_PATHS = [
	path.join(os.homedir(), ".cache", "claude"),
	path.join(os.homedir(), ".cache", "claude-cli-nodejs"),
	path.join(CLAUDE_HOME, "session-env"),
	path.join(CLAUDE_HOME, "projects"),
	CLI_SCRATCH_PARENT_DIR,
];

/**
 * mise's own state (ADR-0012): the per-user tool installs, shims, and
 * config that let a session install whatever node/go/python/etc. version
 * the repo it's working on actually needs. All of it lives under $HOME by
 * mise's own default layout, not under the worktree, so — same reasoning as
 * {@link CLAUDE_SCRATCH_WRITABLE_PATHS} — it needs an explicit
 * `filesystem.allowWrite` grant or every `mise install`/`mise use` fails
 * "read-only file system" under the native sandbox.
 *
 * `.cache/sigstore-rust` is a separate grant for the same reason but a
 * different tool: mise statically links the `sigstore-tuf` crate to verify
 * GitHub artifact attestations on aqua-registry installs (e.g. `pnpm`), and
 * that crate keeps its own TUF trust-root cache outside mise's own
 * `~/.cache/mise` layout. Without this, `mise install pnpm` (and any other
 * attested aqua tool) fails "Failed to create cache directory: Read-only
 * file system" the first time a session's $HOME doesn't already have this
 * directory — confirmed by diffing filesystem writes between a sandboxed
 * and unsandboxed `mise install` run.
 */
const MISE_WRITABLE_PATHS = [
	path.join(os.homedir(), ".local", "share", "mise"),
	path.join(os.homedir(), ".local", "state", "mise"),
	path.join(os.homedir(), ".cache", "mise"),
	path.join(os.homedir(), ".config", "mise"),
	path.join(os.homedir(), ".cache", "sigstore-rust"),
];

/**
 * pnpm defaults its content-addressable store to the topmost directory of
 * the filesystem/mount containing the current project, not `$HOME` — so
 * hard links between the store and a workspace's `node_modules` stay on one
 * device. Inside a dilna worktree that resolves to the root of the
 * `DILNA_DATA_DIR` volume (e.g. `/data/.pnpm-store`), which sits outside the
 * worktree the sandbox confines writes to, so a plain `pnpm install` fails
 * "read-only file system" the same way `mise install` did before
 * {@link MISE_WRITABLE_PATHS}. Rather than granting that volume-root path —
 * unpredictable in general, and far broader than pnpm actually needs — this
 * pins the store inside `$HOME` instead (already sandboxed-writable
 * territory) via the `npm_config_store_dir` env var set in {@link startClaude},
 * which pnpm (and corepack's pnpm) both honor same as any other
 * npm-namespaced config override.
 */
const PNPM_WRITABLE_PATHS = [
	path.join(os.homedir(), ".local", "share", "pnpm"),
];
const PNPM_STORE_DIR = path.join(
	os.homedir(),
	".local",
	"share",
	"pnpm",
	"store",
);

/**
 * Appended to the SDK's `claude_code` system-prompt preset (see `systemPrompt`
 * in {@link startClaude}'s `query()` options) so every session — not just
 * ones where the user happens to explain it — knows the ground truth about
 * where it's actually running. Without an explicit `systemPrompt`, the SDK
 * defaults to an *empty* prompt (confirmed against the installed SDK
 * bundle), not Claude Code's own default one; `preset: 'claude_code'` opts
 * back into that default (tool-use guidance, etc.), and this string is
 * additive context on top of it, not a replacement.
 */
const DILNA_AGENT_CONTEXT = `You are running headless inside dilna, a self-hosted workspace that drives coding agents against locally-cloned repos.

- Your cwd is a git worktree checked out to its own branch, created solely for this session — not the repo's main checkout. Other sessions on the same repo run in sibling worktrees; you won't see their uncommitted work and they won't see yours.
- Bash commands run inside a sandbox confined to this worktree (plus the shared git object store, so git history/commit/branch commands work). Writes outside that boundary fail with a read-only-filesystem error — that's the sandbox, not a bug. Tool calls are auto-approved (no human is present to answer permission prompts), so act autonomously rather than pausing to ask.
- Nothing runtime-specific is pre-installed for the repo you're in. Use mise (already on PATH) to get whatever toolchain it needs: \`mise install\` picks up versions from the repo's own .tool-versions/.nvmrc/.python-version/mise.toml if present, or \`mise use <tool>@<version>\` to pick one yourself. This covers node, pnpm (via corepack once node is installed), go, python, rust, ruby, and more.`;

/**
 * gh (GitHub CLI, ADR-0013): authenticates purely from the GH_TOKEN env var
 * (no `gh auth login`, no host-mounted config — see the Dockerfile's gh
 * install comment), but it may still write a small config/cache under $HOME
 * the first time it runs (e.g. its default config.yml, extension list
 * cache). Granted defensively, same reasoning as MISE_WRITABLE_PATHS above:
 * without this every such write fails "read-only file system" under the
 * native sandbox.
 */
const GH_WRITABLE_PATHS = [
	path.join(os.homedir(), ".config", "gh"),
	path.join(os.homedir(), ".cache", "gh"),
];

/**
 * Spawn a `claude-agent-sdk` query for the given worktree in streaming-input
 * mode, so a single underlying Claude Code subprocess stays resident across
 * multiple user turns (one process per worktree, per ADR-0003). Tool
 * execution runs autonomously via `bypassPermissions`.
 *
 * The Claude Agent SDK's streaming-input `query()` does not emit anything —
 * not even its `system`/`init` handshake — until it has received the *first*
 * item from the prompt async-iterable. Since dilna only
 * ever pushes that first item from {@link chatClaude} (called after this
 * function returns), waiting here for `init` would deadlock. So this
 * function does not wait on the query at all: it starts the background
 * event loop and returns immediately. `agentSessionId` starts empty (or
 * carries over `existingAgentSessionId` on a cold resume) and becomes
 * accurate once the first turn's `init` message arrives.
 */
export async function startClaude(
	opts: ClaudeStartOptions,
): Promise<ClaudeHandle> {
	const stderrTail: string[] = [];
	const inputQueue = createInputQueue();

	// If DILNA_DATA_DIR (and thus every worktree) lives nested inside dilna's
	// own checkout, per ADR-0010 a sandboxed agent's default project-memory
	// discovery would otherwise walk up from the worktree and pick up
	// dilna's own CLAUDE.md while working on someone else's repo — the exact
	// incident this ADR opens with. Deny read on the checkout root and
	// re-open only this worktree (plus its repo's shared git object store,
	// for `git log`/`git diff`), and exclude any CLAUDE.md under the
	// checkout from project-memory loading.
	const gitCommonDir = resolveGitCommonDir(opts.worktreePath);
	const workspaceRoot = findWorkspaceRoot(__dirname);
	const dataDir = getDataDir();
	const nestedInCheckout = dataDir.startsWith(`${workspaceRoot}${path.sep}`);

	const q = query({
		prompt: inputQueue.iterable,
		options: {
			cwd: opts.worktreePath,
			resume: opts.existingAgentSessionId,
			systemPrompt: {
				type: "preset",
				preset: "claude_code",
				append: DILNA_AGENT_CONTEXT,
			},
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
			// mise (ADR-0012) refuses to parse any mise.toml with an [env]/
			// templated-[tasks]/tool-options block until it's explicitly
			// trusted — its own defense against a cloned repo smuggling
			// arbitrary code into a config file nobody reviewed. Without this,
			// every shimmed tool invocation (not just `mise` itself) fails
			// outright the first time a session's worktree contains such a
			// config, until something runs `mise trust` interactively — which
			// nothing in dilna's headless flow ever does. Pre-trusting the
			// whole worktree here matches ADR-0003's existing model (the
			// worktree is already the session's full blast radius, so mise's
			// separate trust gate over the same tree adds friction, not
			// safety). `options.env` replaces the subprocess environment
			// entirely rather than merging with `process.env` (see the SDK's
			// own doc comment on this field), hence the explicit spread.
			env: {
				...process.env,
				MISE_TRUSTED_CONFIG_PATHS: [
					process.env.MISE_TRUSTED_CONFIG_PATHS,
					opts.worktreePath,
				]
					.filter(Boolean)
					.join(":"),
				// See PNPM_STORE_DIR's doc comment: pins pnpm's store inside $HOME
				// (sandboxed-writable) instead of the volume root it'd otherwise
				// resolve to. Only takes effect if nothing in the inherited
				// process.env already set it — an operator's own override wins.
				npm_config_store_dir:
					process.env.npm_config_store_dir ?? PNPM_STORE_DIR,
				// Explicit fallback scratch dir so any ad-hoc temp-file use (a
				// one-off script, `mktemp`, etc.) has somewhere sandboxed-writable
				// to land even if a command runs with the sandbox disabled — that
				// mode doesn't get the sandbox's own default `TMPDIR`, and without
				// this an unset `TMPDIR` has previously caused stray writes to
				// resolve into the worktree root instead (see CLI_SCRATCH_PARENT_DIR's
				// doc comment).
				TMPDIR: process.env.TMPDIR ?? CLI_SCRATCH_PARENT_DIR,
			},
			// Emit stream_event deltas so replies stream token-by-token instead
			// of arriving as whole text blocks. The complete assistant message
			// still follows each delta run — normalizeAssistantMessage dedupes
			// its text via NormalizeState.streamedTextApiMessageIds.
			includePartialMessages: true,
			stderr: (line: string) => {
				const trimmed = line.trim();
				if (!trimmed) return;
				stderrTail.push(trimmed);
				if (stderrTail.length > 50) stderrTail.shift();
			},
			// Per ADR-0003, bypassPermissions is only safe because the process's
			// filesystem writes are confined to the worktree. Enforced here by
			// Claude Code's own built-in sandbox (bwrap-based on Linux, invoked
			// per Bash command from inside the CLI process itself) rather than
			// an external wrapper — see ADR-0010 for why the earlier external
			// wrapper (sandlock) was abandoned.
			sandbox: {
				enabled: true,
				autoAllowBashIfSandboxed: true,
				failIfUnavailable: true,
				// Set only inside dilna's own Docker image (DILNA_CONTAINERIZED=true
				// in the Dockerfile): bwrap can't mount a fresh /proc inside an
				// already-unprivileged container, so it bind-mounts the container's
				// existing one instead. Only safe when an outer container already
				// provides the real isolation boundary, which is the case here but
				// not for bare-host dev.
				enableWeakerNestedSandbox: process.env.DILNA_CONTAINERIZED === "true",
				// No domain is pre-allowed by default, which would otherwise block
				// on an approval prompt no human can answer in dilna's headless
				// sessions. Agents need arbitrary outbound access (LLM APIs, git
				// remotes, whatever they're asked to fetch), matching the
				// previous sandlock config's unconditional `--net-allow '*'`.
				network: { allowedDomains: ["*"] },
				filesystem: {
					// gitCommonDir isn't auto-granted by the native sandbox in
					// practice (see resolveGitCommonDir's doc comment) — without
					// this, `git commit`/`git branch` fail read-only inside every
					// worktree session.
					allowWrite: [
						...CLAUDE_SCRATCH_WRITABLE_PATHS,
						...MISE_WRITABLE_PATHS,
						...PNPM_WRITABLE_PATHS,
						...GH_WRITABLE_PATHS,
						...(gitCommonDir ? [gitCommonDir] : []),
					],
					...(nestedInCheckout
						? {
								denyRead: [workspaceRoot],
								allowRead: [
									opts.worktreePath,
									...(gitCommonDir ? [gitCommonDir] : []),
								],
							}
						: {}),
				},
			},
			...(nestedInCheckout
				? {
						settings: {
							claudeMdExcludes: [
								path.join(workspaceRoot, "CLAUDE.md"),
								path.join(workspaceRoot, "**", "CLAUDE.md"),
							],
						},
					}
				: {}),
		},
	});

	const listeners = new Set<Listener>();
	const exitListeners = new Set<
		(info: { exitCode: number; stderrTail: string[] }) => void
	>();
	const turnEndListeners = new Set<() => void>();
	const state: NormalizeState = createNormalizeState();

	let killed = false;
	let alive = true;
	let agentSessionId = opts.existingAgentSessionId ?? "";
	let apiKeySource: ApiKeySource | null = null;
	let lastAssistantTranscriptUuid: string | undefined;

	const loopPromise = (async () => {
		try {
			for await (const msg of q) {
				if (msg.type === "system" && msg.subtype === "init") {
					agentSessionId = msg.session_id;
					apiKeySource = msg.apiKeySource;
					opts.onInit?.(msg.session_id);
					continue;
				}
				if (msg.type === "rate_limit_event") {
					// SDKRateLimitEvent is documented as only firing "for claude.ai
					// subscription users" — that gating happens SDK-side (an
					// API-key/Bedrock/Vertex session simply never emits this message
					// type), so forward it unconditionally rather than re-checking
					// `apiKeySource` here: real-world values (e.g. `"none"` seen on
					// an actual OAuth subscription session) don't reliably match the
					// documented `'oauth'` literal, and doing so silently dropped
					// genuine rate-limit data.
					opts.onRateLimit?.(msg.rate_limit_info);
					continue;
				}
				// Complete assistant messages carry the uuid the transcript will
				// hold for this round — recorded for the post-turn sync gate (see
				// lastAssistantTranscriptUuid's doc comment on ClaudeHandle).
				if (msg.type === "assistant") {
					lastAssistantTranscriptUuid = msg.uuid;
				}
				const events = normalizeMessage(msg, state);
				for (const ev of events) {
					for (const listener of listeners) {
						try {
							listener(ev);
						} catch {
							// listener errors are non-fatal
						}
					}
				}
				if (msg.type === "result") {
					for (const listener of turnEndListeners) {
						try {
							listener();
						} catch {
							// listener errors are non-fatal
						}
					}
				}
			}
		} catch (err) {
			if (!killed) {
				const tail = stderrTail.length
					? `\n${stderrTail.join("\n")}`
					: " (no subprocess stderr captured)";
				console.error(
					`[claude-agent] event loop error: ${err instanceof Error ? err.message : String(err)}${tail}`,
				);
			}
		} finally {
			alive = false;
			if (!killed) {
				const info = { exitCode: -1, stderrTail };
				for (const listener of exitListeners) {
					try {
						listener(info);
					} catch {
						// listener errors during crash fan-out are non-fatal
					}
				}
				exitListeners.clear();
				listeners.clear();
			}
		}
	})();

	// Give an immediate spawn failure (missing binary, bad cwd) a brief
	// window to surface here rather than only on the first chat call. This
	// is best-effort, not a readiness gate: the query is otherwise fully
	// inert (no init, no subprocess I/O beyond stdin-open) until the first
	// message is pushed, so there's nothing meaningful to wait for beyond
	// "did it die immediately."
	await Promise.race([loopPromise, setTimeoutAsync(300)]);
	if (!alive) {
		throw new Error(
			`claude agent exited immediately on start\n${stderrTail.slice(-5).join("\n")}`,
		);
	}

	const stop = async () => {
		if (killed) return;
		killed = true;
		// A turn may still be in flight: clearing `listeners`/`turnEndListeners`
		// unhooks chatClaude's own completion listener, so without a final
		// signal its promise would never settle and the caller's sendMessage
		// would sit wedged until the turn timeout fired, then spuriously mark
		// the deliberately-stopped session crashed. Fire turn-end once so
		// in-flight chatClaude calls resolve and run their normal end-of-turn
		// persistence over the partial turn.
		for (const listener of turnEndListeners) {
			try {
				listener();
			} catch {
				// listener errors during teardown are non-fatal
			}
		}
		listeners.clear();
		turnEndListeners.clear();
		inputQueue.close();
		try {
			q.close();
		} catch {
			// already closed
		}
		await loopPromise.catch(() => {});
	};

	const isAlive = () => alive && !killed;

	const sendUserMessage = (text: string) => {
		inputQueue.push({
			type: "user",
			message: { role: "user", content: text },
			parent_tool_use_id: null,
		});
	};

	return {
		kind: "claude",
		get agentSessionId() {
			return agentSessionId;
		},
		get apiKeySource() {
			return apiKeySource;
		},
		get lastAssistantTranscriptUuid() {
			return lastAssistantTranscriptUuid;
		},
		worktreePath: opts.worktreePath,
		listeners,
		exitListeners,
		turnEndListeners,
		stop,
		isAlive,
		stderrTail,
		query: q,
		sendUserMessage,
	};
}

/**
 * Send a single user message to the agent and resolve when the turn goes
 * idle. Events that arrive via the persistent query loop are normalized to
 * dilna's {@link AgentStreamEvent} union and forwarded to
 * {@link opts.onEvent}.
 *
 * Returns the transcript uuid of the last complete assistant message this
 * turn produced (or undefined if none arrived, e.g. an aborted/errored
 * turn). Claude's own transcript file can lag behind this turn's `result`
 * event by a beat, so callers that re-sync persisted history from
 * `getSessionMessages` need this uuid to know specifically what to wait
 * for — see `SessionManager.fetchClaudeMessagesWithRetry`. It must be a
 * transcript uuid, not the normalized live messageId — see
 * {@link ClaudeHandle.lastAssistantTranscriptUuid}.
 */
export async function chatClaude(
	handle: ClaudeHandle,
	opts: AgentChatOptions,
): Promise<string | undefined> {
	const { listeners } = handle;
	const { message, onEvent, abortSignal } = opts;

	if (!handle.isAlive()) {
		throw new Error(
			`claude agent process exited\n${handle.stderrTail.slice(-5).join("\n")}`,
		);
	}

	// Snapshot so the return value only reflects assistant messages produced
	// by *this* turn — an unchanged value means the turn produced none.
	const transcriptUuidAtStart = handle.lastAssistantTranscriptUuid;
	const chatListener: Listener = (ev) => {
		onEvent(ev);
	};
	listeners.add(chatListener);

	let resolveChat!: () => void;
	let rejectChat!: (err: Error) => void;
	const chatDone = new Promise<void>((res, rej) => {
		resolveChat = res;
		rejectChat = rej;
	});

	const turnEndListener = () => {
		resolveChat();
	};
	handle.turnEndListeners.add(turnEndListener);

	const exitListener = (info: { exitCode: number; stderrTail: string[] }) => {
		rejectChat(
			new Error(
				`claude agent process exited\n${info.stderrTail.slice(-5).join("\n")}`,
			),
		);
	};
	handle.exitListeners.add(exitListener);

	const abortHandler = async () => {
		try {
			await handle.query.interrupt();
		} catch {
			// ignore abort errors
		}
		resolveChat();
	};
	if (abortSignal) {
		if (abortSignal.aborted) {
			await abortHandler();
			return;
		}
		abortSignal.addEventListener("abort", abortHandler, { once: true });
	}

	try {
		handle.sendUserMessage(message);
		await chatDone;
		const latest = handle.lastAssistantTranscriptUuid;
		return latest !== transcriptUuidAtStart ? latest : undefined;
	} finally {
		listeners.delete(chatListener);
		handle.turnEndListeners.delete(turnEndListener);
		handle.exitListeners.delete(exitListener);
		if (abortSignal) {
			abortSignal.removeEventListener("abort", abortHandler);
		}
	}
}

function createInputQueue(): {
	push: (msg: SDKUserMessage) => void;
	close: () => void;
	iterable: AsyncIterable<SDKUserMessage>;
} {
	const pending: SDKUserMessage[] = [];
	let wake: (() => void) | null = null;
	let closed = false;

	const push = (msg: SDKUserMessage) => {
		pending.push(msg);
		if (wake) {
			wake();
			wake = null;
		}
	};
	const close = () => {
		closed = true;
		if (wake) {
			wake();
			wake = null;
		}
	};

	async function* generate(): AsyncGenerator<SDKUserMessage> {
		while (true) {
			if (pending.length > 0) {
				yield pending.shift() as SDKUserMessage;
				continue;
			}
			if (closed) return;
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
		}
	}

	return { push, close, iterable: generate() };
}

// Exported for unit testing the per-message/turn-end usage normalization
// (see claude.test.ts) without spawning a real agent subprocess.
export function normalizeMessage(
	msg: SDKMessage,
	state: NormalizeState,
): AgentStreamEvent[] {
	switch (msg.type) {
		case "stream_event":
			return normalizeStreamEvent(msg, state);
		case "assistant":
			return normalizeAssistantMessage(msg, state);
		case "user":
			return normalizeUserMessage(msg, state);
		case "result":
			return normalizeResultMessage(msg, state);
		case "tool_progress":
			return normalizeToolProgress(msg, state);
		case "system":
			return normalizeSystemMessage(msg, state);
		default:
			return [];
	}
}

/**
 * Build the current `turn_activity` broadcast from the aggregate — called
 * after every message that touches it (ADR-0016 §5). `serverTime` lets the
 * client correct clock skew when ticking elapsed time off `startedAt`.
 */
function activityEvent(state: NormalizeState): AgentStreamEvent {
	return {
		type: "turn_activity",
		phase: state.activity.phase,
		runningTools: [...state.activity.runningTools.entries()].map(
			([callId, t]) => ({ callId, tool: t.tool, startedAt: t.startedAt }),
		),
		tasks: [...state.activity.tasks.entries()].map(([taskId, t]) => ({
			taskId,
			...t,
		})),
		thinkingTokens: state.activity.thinkingTokens,
		serverTime: Date.now(),
	};
}

function normalizeToolProgress(
	msg: SDKToolProgressMessage,
	state: NormalizeState,
): AgentStreamEvent[] {
	if (!state.activity.runningTools.has(msg.tool_use_id)) {
		state.activity.runningTools.set(msg.tool_use_id, {
			tool: msg.tool_name,
			startedAt: Date.now(),
		});
	}
	return [activityEvent(state)];
}

function normalizeSystemMessage(
	msg: Extract<SDKMessage, { type: "system" }>,
	state: NormalizeState,
): AgentStreamEvent[] {
	switch (msg.subtype) {
		case "status":
			return normalizeStatusMessage(msg, state);
		case "api_retry":
			return normalizeApiRetryMessage(msg, state);
		case "task_started":
			return normalizeTaskStarted(msg, state);
		case "task_progress":
			return normalizeTaskProgress(msg, state);
		case "task_updated":
			return normalizeTaskUpdated(msg, state);
		case "task_notification":
			return normalizeTaskNotification(msg, state);
		case "thinking_tokens":
			return normalizeThinkingTokens(msg, state);
		case "model_refusal_fallback":
			return normalizeModelRefusalFallback(msg);
		default:
			return [];
	}
}

function normalizeStatusMessage(
	msg: SDKStatusMessage,
	state: NormalizeState,
): AgentStreamEvent[] {
	state.activity.phase =
		msg.status === "requesting" || msg.status === "compacting"
			? { kind: msg.status }
			: null;
	return [activityEvent(state)];
}

function normalizeApiRetryMessage(
	msg: SDKAPIRetryMessage,
	state: NormalizeState,
): AgentStreamEvent[] {
	state.activity.phase = {
		kind: "retrying",
		attempt: msg.attempt,
		maxRetries: msg.max_retries,
	};
	return [activityEvent(state)];
}

function normalizeTaskStarted(
	msg: SDKTaskStartedMessage,
	state: NormalizeState,
): AgentStreamEvent[] {
	state.activity.tasks.set(msg.task_id, {
		description: msg.description,
		lastTool: "",
		toolUses: 0,
		startedAt: Date.now(),
		toolUseId: msg.tool_use_id,
	});
	return [activityEvent(state)];
}

function normalizeTaskProgress(
	msg: SDKTaskProgressMessage,
	state: NormalizeState,
): AgentStreamEvent[] {
	const existing = state.activity.tasks.get(msg.task_id);
	state.activity.tasks.set(msg.task_id, {
		description: existing?.description ?? "",
		lastTool: msg.last_tool_name ?? existing?.lastTool ?? "",
		toolUses: msg.usage.tool_uses,
		startedAt: existing?.startedAt ?? Date.now(),
		toolUseId: existing?.toolUseId ?? msg.tool_use_id,
	});
	return [activityEvent(state)];
}

function normalizeTaskUpdated(
	msg: SDKTaskUpdatedMessage,
	state: NormalizeState,
): AgentStreamEvent[] {
	const existing = state.activity.tasks.get(msg.task_id);
	if (!existing) return [];
	if (
		msg.patch.status === "completed" ||
		msg.patch.status === "failed" ||
		msg.patch.status === "killed"
	) {
		state.activity.tasks.delete(msg.task_id);
	} else if (msg.patch.description) {
		state.activity.tasks.set(msg.task_id, {
			...existing,
			description: msg.patch.description,
		});
	}
	return [activityEvent(state)];
}

function normalizeTaskNotification(
	msg: SDKTaskNotificationMessage,
	state: NormalizeState,
): AgentStreamEvent[] {
	state.activity.tasks.delete(msg.task_id);
	return [activityEvent(state)];
}

function normalizeThinkingTokens(
	msg: SDKThinkingTokensMessage,
	state: NormalizeState,
): AgentStreamEvent[] {
	state.activity.thinkingTokens = msg.estimated_tokens;
	return [activityEvent(state)];
}

/**
 * Refusal-fallback retraction (ADR-0016 §5). Rather than surgically evicting
 * the retracted parts from the manager's `LiveTurn` snapshot — which is
 * keyed by dilna's own messageId/callId, not the wire uuids this message
 * carries, with no existing mapping between them — the manager resets the
 * whole in-flight snapshot on this signal (a conservative superset of
 * "evict the retracted content") and emits `resync` for every client to
 * reconcile from. This adapter just surfaces the raw signal as a `notice` +
 * `resync` pair; `retracted_message_uuids` itself isn't needed downstream
 * under that simplification.
 */
function normalizeModelRefusalFallback(
	msg: SDKModelRefusalFallbackMessage,
): AgentStreamEvent[] {
	return [
		{
			type: "notice",
			message: `${msg.trigger === "refusal" ? "The model declined to continue and" : "The turn"} retried on a fallback model.`,
		},
		{ type: "resync" },
	];
}

/**
 * Partial-message deltas (enabled via `includePartialMessages`). Only two of
 * the raw stream events matter here: `message_start` opens the turn message
 * (and records the API message id so the complete assistant message that
 * follows doesn't re-emit its text — see
 * {@link NormalizeState.streamedTextApiMessageIds}), and text
 * `content_block_delta`s become `token` events. Everything else —
 * `input_json_delta` (partial tool input), thinking deltas, block/message
 * stops — is ignored; tool_use blocks, usage, and errors keep coming from
 * the complete `SDKAssistantMessage`.
 */
function normalizeStreamEvent(
	msg: SDKPartialAssistantMessage,
	state: NormalizeState,
): AgentStreamEvent[] {
	const event = msg.event;

	if (event.type === "message_start") {
		state.streamedTextApiMessageIds.add(event.message.id);
		if (!state.currentTurnMessageId) {
			state.currentTurnMessageId = msg.uuid;
		}
		const messageId = state.currentTurnMessageId;
		if (!state.seenMessageStarts.has(messageId)) {
			state.seenMessageStarts.add(messageId);
			return [{ type: "message_start", messageId, role: "assistant" }];
		}
		return [];
	}

	if (
		event.type === "content_block_delta" &&
		event.delta.type === "text_delta" &&
		event.delta.text.length > 0
	) {
		return [
			{
				type: "token",
				messageId: state.currentTurnMessageId ?? msg.uuid,
				chunk: event.delta.text,
			},
		];
	}

	if (
		event.type === "content_block_delta" &&
		event.delta.type === "thinking_delta" &&
		event.delta.thinking.length > 0
	) {
		return [
			{
				type: "thinking",
				messageId: state.currentTurnMessageId ?? msg.uuid,
				chunk: event.delta.thinking,
			},
		];
	}

	return [];
}

function normalizeAssistantMessage(
	msg: SDKAssistantMessage,
	state: NormalizeState,
): AgentStreamEvent[] {
	const events: AgentStreamEvent[] = [];
	if (!state.currentTurnMessageId) {
		state.currentTurnMessageId = msg.uuid;
	}
	const messageId = state.currentTurnMessageId;
	if (!state.seenMessageStarts.has(messageId)) {
		state.seenMessageStarts.add(messageId);
		events.push({ type: "message_start", messageId, role: "assistant" });
	}

	// Text already delivered incrementally as stream_event deltas for this
	// API message — don't emit it a second time.
	const apiMessageId = (msg.message as { id?: unknown }).id;
	const textAlreadyStreamed =
		typeof apiMessageId === "string" &&
		state.streamedTextApiMessageIds.has(apiMessageId);

	const content = (msg.message as { content?: unknown }).content;
	const blocks = Array.isArray(content) ? (content as ContentBlock[]) : [];
	for (const block of blocks) {
		if (block.type === "text") {
			if (textAlreadyStreamed) continue;
			const text = (block.text as string) ?? "";
			if (text.length > 0) {
				events.push({ type: "token", messageId, chunk: text });
			}
		} else if (block.type === "tool_use") {
			const callId = block.id as string;
			state.toolMessageIds.set(callId, messageId);
			events.push({
				type: "tool_call_start",
				messageId,
				callId,
				tool: (block.name as string) ?? "unknown",
				input: block.input,
			});
		}
	}

	const usage = extractUsageTotals((msg.message as { usage?: unknown }).usage);
	if (usage) {
		events.push({ type: "usage_update", messageId, usage });
	}

	if (msg.error) {
		events.push({
			type: "turn_failed",
			class: "turn_error",
			message: `claude agent error: ${msg.error}`,
		});
	}

	return events;
}

/**
 * Reads token counts off a Messages-API-shaped `usage` object — present on
 * every `SDKAssistantMessage.message.usage` (per-API-call, not cumulative
 * within a turn) and on `SDKResultMessage.usage`. Despite the SDK docs
 * calling the latter session-cumulative, in streaming-input mode it is
 * per-turn (verified empirically — two turns in one process reported 3319
 * then 2 input tokens, not a running sum); SessionManager does the actual
 * session-lifetime accumulation. Tokens only, per issue #10 — cost fields
 * (`total_cost_usd`, `costUSD`) are intentionally ignored. See
 * docs/research/claude-agent-sdk-usage-limits.md.
 */
function extractUsageTotals(usage: unknown): UsageTotals | null {
	if (!usage || typeof usage !== "object") return null;
	const u = usage as { input_tokens?: unknown; output_tokens?: unknown };
	if (
		typeof u.input_tokens !== "number" ||
		typeof u.output_tokens !== "number"
	) {
		return null;
	}
	return { inputTokens: u.input_tokens, outputTokens: u.output_tokens };
}

function normalizeUserMessage(
	msg: SDKUserMessage,
	state: NormalizeState,
): AgentStreamEvent[] {
	const content = (msg.message as { content?: unknown }).content;
	const blocks = Array.isArray(content) ? (content as ContentBlock[]) : [];
	const events: AgentStreamEvent[] = [];
	for (const block of blocks) {
		if (block.type !== "tool_result") continue;
		const callId = block.tool_use_id as string;
		const messageId = state.toolMessageIds.get(callId) ?? msg.uuid ?? callId;
		const isError = block.is_error === true;
		const output = blockContentToText(block.content);
		events.push({
			type: "tool_call_end",
			messageId,
			callId,
			output,
			error: isError ? output : undefined,
		});
		if (state.activity.runningTools.delete(callId)) {
			events.push(activityEvent(state));
		}
	}
	return events;
}

function normalizeResultMessage(
	msg: SDKResultMessage,
	state: NormalizeState,
): AgentStreamEvent[] {
	// End of turn — the next assistant message starts a fresh turn id. Fall
	// back to the result's own uuid so the reconciling usage_update below
	// still has a messageId even on a turn with no assistant content.
	const turnMessageId = state.currentTurnMessageId ?? msg.uuid;
	state.currentTurnMessageId = null;
	state.streamedTextApiMessageIds.clear();
	// `turn_activity` is valid only inside a turn (ADR-0016 §5) — reset the
	// aggregate so the next turn starts from a clean slate; no explicit
	// clearing event is needed, the client clears its own copy on terminal.
	state.activity = {
		phase: null,
		runningTools: new Map(),
		tasks: new Map(),
		thinkingTokens: undefined,
	};

	const events: AgentStreamEvent[] = [];
	// This turn's total usage (per-turn, not session-cumulative — see
	// extractUsageTotals). Emitted in `cumulative` position so SessionManager
	// folds it into the session's persisted lifetime total and rewrites the
	// field to that total before broadcasting.
	const turnUsage = extractUsageTotals(msg.usage);
	if (turnUsage) {
		events.push({
			type: "usage_update",
			messageId: turnMessageId,
			usage: turnUsage,
			cumulative: turnUsage,
		});
	}

	if (msg.subtype !== "success") {
		const detail = msg.errors?.length ? ` — ${msg.errors.join("; ")}` : "";
		events.push({
			type: "turn_failed",
			class: "turn_error",
			message: `claude agent turn ended: ${msg.subtype}${detail}`,
		});
	}
	// No `session_status` here — only SessionManager may emit that (ADR-0016
	// §1); turn completion reaches it via ClaudeHandle.turnEndListeners
	// instead (see the `for await` loop in startClaude).
	return events;
}

function blockContentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((c) =>
				c && typeof c === "object" && (c as ContentBlock).type === "text"
					? (((c as ContentBlock).text as string) ?? "")
					: "",
			)
			.join("");
	}
	return "";
}
