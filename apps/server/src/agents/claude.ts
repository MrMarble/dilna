import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as setTimeoutAsync } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	type Query,
	query,
	type SDKAssistantMessage,
	type SDKMessage,
	type SDKResultMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentStreamEvent } from "@dilna/shared";
import { getDataDir } from "../db";
import type { AgentChatOptions, AgentStartOptions } from "./types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * A git worktree's `.git` is a *file* (not a directory) pointing at its own
 * metadata directory (HEAD, index, refs, logs) under the origin repo's git
 * dir. That metadata dir's own `commondir` file in turn points at the
 * *shared* git dir (objects, refs, config) — normally `../..`, i.e. the bare
 * repo root itself. The native sandbox (see {@link startClaude}) already
 * grants the shared dir write access automatically for a worktree cwd, but
 * not read access, so this is used to add it to `filesystem.allowRead`
 * ourselves when `denyRead` would otherwise cover it (e.g. `git log`/`git
 * diff` need to read historical objects from the shared store).
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

export type ClaudeHandle = {
	kind: "claude";
	/**
	 * The Claude-side session id. Empty until the first turn's `system init`
	 * message arrives (see {@link startClaude}), so this is a getter over
	 * live state rather than a value snapshotted at handle-creation time.
	 */
	readonly agentSessionId: string;
	worktreePath: string;
	listeners: Set<Listener>;
	stop: () => Promise<void>;
	isAlive: () => boolean;
	stderrTail: string[];
	query: Query;
	/** Pushes a user turn onto the query's streaming-input prompt. */
	sendUserMessage: (text: string) => void;
};

type NormalizeState = {
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
};

/**
 * dilna's own writable scratch paths for the Claude CLI — its cache,
 * transcript storage, and session-env directory, not project files. Passed
 * to the native sandbox's `filesystem.allowWrite` (see {@link startClaude}).
 * `~/.claude/projects` is the CLI's own transcript storage — `getSessionMessages`/
 * `getSessionInfo` in sessions/manager.ts read from here after every turn;
 * without this grant persisted history and title auto-sync silently stay
 * empty. `/tmp/claude-<uid>` is the CLI's own per-invocation scratch dir,
 * named after the (sanitized) worktree path plus a random suffix it picks
 * itself — ungrantable at the exact leaf, so the whole per-uid parent is
 * granted instead.
 */
const CLAUDE_SCRATCH_WRITABLE_PATHS = [
	path.join(os.homedir(), ".cache", "claude"),
	path.join(os.homedir(), ".cache", "claude-cli-nodejs"),
	path.join(os.homedir(), ".claude", "session-env"),
	path.join(os.homedir(), ".claude", "projects"),
	path.join(os.tmpdir(), `claude-${process.getuid?.() ?? 0}`),
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
	opts: AgentStartOptions,
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
			permissionMode: "bypassPermissions",
			allowDangerouslySkipPermissions: true,
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
					allowWrite: CLAUDE_SCRATCH_WRITABLE_PATHS,
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
	const state: NormalizeState = {
		seenMessageStarts: new Set(),
		toolMessageIds: new Map(),
		currentTurnMessageId: null,
	};

	let killed = false;
	let alive = true;
	let agentSessionId = opts.existingAgentSessionId ?? "";

	const loopPromise = (async () => {
		try {
			for await (const msg of q) {
				if (msg.type === "system" && msg.subtype === "init") {
					agentSessionId = msg.session_id;
					continue;
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
				const crashed: AgentStreamEvent = {
					type: "agent_crashed",
					exitCode: -1,
					stderrTail,
				};
				for (const listener of listeners) {
					try {
						listener(crashed);
					} catch {
						// listener errors during crash fan-out are non-fatal
					}
				}
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
		listeners.clear();
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
		worktreePath: opts.worktreePath,
		listeners,
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
 * Returns the messageId of the last assistant message_start seen during
 * this turn (or undefined if none arrived, e.g. an aborted/errored turn).
 * Claude's own transcript file can lag behind this turn's `result` event by
 * a beat, so callers that re-sync persisted history from
 * `getSessionMessages` need this id to know specifically what to wait for
 * — see `SessionManager.fetchClaudeMessagesWithRetry`.
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

	let lastAssistantMessageId: string | undefined;
	const chatListener: Listener = (ev) => {
		if (ev.type === "message_start" && ev.role === "assistant") {
			lastAssistantMessageId = ev.messageId;
		}
		onEvent(ev);
	};
	listeners.add(chatListener);

	let resolveChat!: () => void;
	let rejectChat!: (err: Error) => void;
	const chatDone = new Promise<void>((res, rej) => {
		resolveChat = res;
		rejectChat = rej;
	});

	const completionListener: Listener = (ev) => {
		if (ev.type === "session_status" && ev.status === "idle") {
			resolveChat();
		} else if (ev.type === "agent_crashed") {
			rejectChat(
				new Error(
					`claude agent process exited\n${ev.stderrTail.slice(-5).join("\n")}`,
				),
			);
		}
	};
	listeners.add(completionListener);

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
		return lastAssistantMessageId;
	} finally {
		listeners.delete(chatListener);
		listeners.delete(completionListener);
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

function normalizeMessage(
	msg: SDKMessage,
	state: NormalizeState,
): AgentStreamEvent[] {
	switch (msg.type) {
		case "assistant":
			return normalizeAssistantMessage(msg, state);
		case "user":
			return normalizeUserMessage(msg, state);
		case "result":
			return normalizeResultMessage(msg, state);
		default:
			return [];
	}
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

	const content = (msg.message as { content?: unknown }).content;
	const blocks = Array.isArray(content) ? (content as ContentBlock[]) : [];
	for (const block of blocks) {
		if (block.type === "text") {
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

	if (msg.error) {
		events.push({
			type: "error",
			message: `claude agent error: ${msg.error}`,
		});
	}

	return events;
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
	}
	return events;
}

function normalizeResultMessage(
	msg: SDKResultMessage,
	state: NormalizeState,
): AgentStreamEvent[] {
	// End of turn — the next assistant message starts a fresh turn id.
	state.currentTurnMessageId = null;
	if (msg.subtype !== "success") {
		const detail = msg.errors?.length ? ` — ${msg.errors.join("; ")}` : "";
		return [
			{
				type: "error",
				message: `claude agent turn ended: ${msg.subtype}${detail}`,
			},
			{ type: "session_status", status: "idle" },
		];
	}
	return [{ type: "session_status", status: "idle" }];
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
