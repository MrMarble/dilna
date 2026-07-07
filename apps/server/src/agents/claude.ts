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
	agentSessionId: string;
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
};

/**
 * Spawn a `claude-agent-sdk` query for the given worktree in streaming-input
 * mode, so a single underlying Claude Code subprocess stays resident across
 * multiple user turns (mirroring one `opencode serve` process per worktree,
 * per ADR-0003). Tool execution runs autonomously via `bypassPermissions`,
 * matching opencode's `permission: allow` auto-approve behavior.
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
	};

	let killed = false;
	let alive = true;
	let agentSessionId = opts.existingAgentSessionId ?? "";

	let resolveReady!: () => void;
	let rejectReady!: (err: Error) => void;
	let readySettled = false;
	const ready = new Promise<void>((res, rej) => {
		resolveReady = res;
		rejectReady = rej;
	});
	const settleReady = (fn: () => void) => {
		if (readySettled) return;
		readySettled = true;
		fn();
	};

	const loopPromise = (async () => {
		try {
			for await (const msg of q) {
				if (msg.type === "system" && msg.subtype === "init") {
					agentSessionId = msg.session_id;
					settleReady(resolveReady);
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
				settleReady(() =>
					rejectReady(
						new Error(
							`claude agent exited before becoming ready\n${stderrTail.slice(-5).join("\n")}`,
						),
					),
				);
			}
		}
	})();

	try {
		await waitForReady(ready, 20_000);
	} catch (err) {
		killed = true;
		inputQueue.close();
		try {
			q.close();
		} catch {
			// already closed
		}
		await loopPromise.catch(() => {});
		throw err;
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
		agentSessionId,
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
 */
export async function chatClaude(
	handle: ClaudeHandle,
	opts: AgentChatOptions,
): Promise<void> {
	const { listeners } = handle;
	const { message, onEvent, abortSignal } = opts;

	const chatListener: Listener = (ev) => onEvent(ev);
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
			return normalizeResultMessage(msg);
		default:
			return [];
	}
}

function normalizeAssistantMessage(
	msg: SDKAssistantMessage,
	state: NormalizeState,
): AgentStreamEvent[] {
	const events: AgentStreamEvent[] = [];
	const messageId = msg.uuid;
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

function normalizeResultMessage(msg: SDKResultMessage): AgentStreamEvent[] {
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

async function waitForReady(
	ready: Promise<void>,
	timeoutMs: number,
): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(
				new Error(`claude agent did not become ready within ${timeoutMs}ms`),
			);
		}, timeoutMs);
	});
	try {
		await Promise.race([ready, timeout]);
	} finally {
		clearTimeout(timer);
	}
}
