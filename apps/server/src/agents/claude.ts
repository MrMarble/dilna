import { setTimeout as setTimeoutAsync } from "node:timers/promises";
import {
	type Query,
	query,
	type SDKAssistantMessage,
	type SDKMessage,
	type SDKResultMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentStreamEvent } from "@dilna/shared";
import type { AgentChatOptions, AgentStartOptions } from "./types";

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
	 * dilna's message model expects one assistant messageId per user turn
	 * (matching opencode, which keeps a single message id across an entire
	 * tool-calling loop). Claude's transcript instead starts a brand new
	 * SDKAssistantMessage — a new uuid — after every tool round-trip. This
	 * pins every assistant message within one turn to the *first* uuid seen,
	 * so the live UI renders one growing message with one tool-call group
	 * instead of a separate single-tool-call message per round. Reset to
	 * null on `result` (end of turn) so the next turn gets its own id.
	 */
	currentTurnMessageId: string | null;
};

/**
 * Spawn a `claude-agent-sdk` query for the given worktree in streaming-input
 * mode, so a single underlying Claude Code subprocess stays resident across
 * multiple user turns (mirroring one `opencode serve` process per worktree,
 * per ADR-0003). Tool execution runs autonomously via `bypassPermissions`,
 * matching opencode's `permission: allow` auto-approve behavior.
 *
 * Unlike opencode (an HTTP server that answers a readiness probe before any
 * session exists), the Claude Agent SDK's streaming-input `query()` does not
 * emit anything — not even its `system`/`init` handshake — until it has
 * received the *first* item from the prompt async-iterable. Since dilna only
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
				console.error(
					`[claude-agent] event loop error: ${err instanceof Error ? err.message : String(err)}`,
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
 * {@link opts.onEvent}, mirroring {@link chatOpencode}.
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
