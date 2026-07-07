import { spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as setTimeoutAsync } from "node:timers/promises";
import type { AgentStreamEvent } from "@dilna/shared";
import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import type { AgentChatOptions, AgentStartOptions } from "./types";

// Opencode's SDK types are large and unstable in shape; we import only the
// ones we use here and treat the rest as opaque `Record<string, unknown>`.
type OEvent = { type: string; properties: Record<string, unknown> };
type OPart = {
	id: string;
	sessionID: string;
	messageID: string;
	type: string;
	[key: string]: unknown;
};
type OToolPart = OPart & { callID: string; tool: string; state: ToolState };
type ToolState =
	| { status: "pending" | "running"; input: Record<string, unknown> }
	| { status: "completed"; output: string }
	| { status: "error"; error: string };
type OMessage = { id: string; sessionID: string; role: "user" | "assistant" };

export type Listener = (event: AgentStreamEvent) => void;

export type OpencodeHandle = {
	agentSessionId: string;
	client: OpencodeClient;
	listeners: Set<Listener>;
	stop: () => Promise<void>;
	isAlive: () => boolean;
	stderrTail: string[];
};

/**
 * Spawn an `opencode serve` process for the given worktree, create or
 * resume an opencode session, and start a persistent event subscription
 * that fans events out to registered listeners.
 *
 * Per ADR-0003: one `opencode serve` process per active session, with
 * --auto to allow the agent to run autonomously without per-tool approvals.
 */
export async function startOpencode(
	opts: AgentStartOptions,
): Promise<OpencodeHandle> {
	const port = await pickFreePort();
	const child = spawn(
		"opencode",
		["serve", "--port", String(port), "--hostname", "127.0.0.1"],
		{
			stdio: ["ignore", "pipe", "pipe"],
			cwd: opts.worktreePath,
			env: {
				...process.env,
				// Auto-approve all tool calls (replacement for `opencode --auto`,
				// which isn't valid on the `serve` subcommand). Per ADR-0003 the
				// agent runs in isolation inside dilna so this is safe.
				OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: "allow" }),
			},
		},
	);

	const stderrTail: string[] = [];
	child.stderr?.on("data", (b: Buffer) => {
		const line = b.toString().trim();
		if (!line) return;
		stderrTail.push(line);
		if (stderrTail.length > 50) stderrTail.shift();
	});

	const url = await waitForReady(child, 15_000);
	const client = createOpencodeClient({ baseUrl: url, throwOnError: true });

	let agentSessionId = opts.existingAgentSessionId ?? null;
	if (!agentSessionId) {
		const res = await client.session.create({ throwOnError: true });
		agentSessionId = res.data.id;
	}
	const sessionId = agentSessionId;

	const listeners = new Set<Listener>();
	const subscriptionPromise = runEventLoop(client, listeners, sessionId).catch(
		(err) => {
			if (
				err instanceof Error &&
				!err.message.includes("aborted") &&
				!err.message.includes("ECONNREFUSED")
			) {
				console.error(`[opencode-agent] event loop error: ${err.message}`);
			}
		},
	);

	let killed = false;
	const stop = async () => {
		if (killed) return;
		killed = true;
		listeners.clear();
		if (!child.killed) {
			child.kill("SIGTERM");
			await Promise.race([
				once(child, "exit"),
				setTimeoutAsync(3_000).then(() => {
					try {
						if (!child.killed) child.kill("SIGKILL");
					} catch {
						// already dead
					}
					return once(child, "exit");
				}),
			]);
		}
		await subscriptionPromise.catch(() => {});
	};

	const isAlive = () =>
		!killed && child.exitCode === null && child.signalCode === null;

	// Crash detection: if the child exits unexpectedly, notify listeners
	// with an agent_crashed event so SessionManager can mark the session
	// accordingly.
	child.once("exit", (code) => {
		if (killed) return;
		const crashed: AgentStreamEvent = {
			type: "agent_crashed",
			exitCode: code ?? -1,
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
	});

	return {
		agentSessionId: sessionId,
		client,
		listeners,
		stop,
		isAlive,
		stderrTail,
	};
}

/**
 * Send a single user message to the agent and resolve when the session
 * goes idle (i.e. the agent has finished responding). Events that arrive
 * via the persistent subscription are normalized to dilna's
 * {@link AgentStreamEvent} union and forwarded to {@link opts.onEvent}.
 */
export async function chatOpencode(
	handle: OpencodeHandle,
	opts: AgentChatOptions,
): Promise<void> {
	const { client, listeners, agentSessionId } = handle;
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
					`opencode process exited (code ${ev.exitCode})\n${ev.stderrTail.slice(-5).join("\n")}`,
				),
			);
		}
	};
	listeners.add(completionListener);

	const abortHandler = async () => {
		try {
			await client.session.abort({ path: { id: agentSessionId } });
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
		await client.session.promptAsync({
			path: { id: agentSessionId },
			body: { parts: [{ type: "text", text: message }] },
			throwOnError: true,
		});
		await chatDone;
	} finally {
		listeners.delete(chatListener);
		listeners.delete(completionListener);
		if (abortSignal) {
			abortSignal.removeEventListener("abort", abortHandler);
		}
	}
}
async function runEventLoop(
	client: OpencodeClient,
	listeners: Set<Listener>,
	sessionId: string,
): Promise<void> {
	const result = (await client.event.subscribe()) as {
		stream: AsyncIterable<OEvent>;
	};
	const stream = result.stream;
	const seenMessageStarts = new Set<string>();
	const seenTextMessages = new Set<string>();
	for await (const ev of stream) {
		if (!ev || typeof ev !== "object") continue;
		const normalized = normalizeEvent(
			ev,
			sessionId,
			seenMessageStarts,
			seenTextMessages,
		);
		if (!normalized) continue;
		for (const listener of listeners) {
			try {
				listener(normalized);
			} catch {
				// listener errors are non-fatal
			}
		}
		if (normalized.type === "agent_crashed") return;
	}
}

function normalizeEvent(
	ev: OEvent,
	targetSessionId: string,
	seenMessageStarts: Set<string>,
	seenTextMessages: Set<string>,
): AgentStreamEvent | null {
	switch (ev.type) {
		case "message.updated": {
			const info = ev.properties.info as OMessage;
			if (info?.sessionID !== targetSessionId) return null;
			// Only emit message_start once per messageId — opencode fires
			// message.updated many times for the same message as it streams.
			if (seenMessageStarts.has(info.id)) return null;
			seenMessageStarts.add(info.id);
			return {
				type: "message_start",
				messageId: info.id,
				role: info.role,
			};
		}
		case "message.part.updated": {
			const part = ev.properties.part as OPart;
			if (!part || part.sessionID !== targetSessionId) return null;
			return normalizePartUpdate(
				part,
				ev.properties.delta as string | undefined,
				seenTextMessages,
			);
		}
		case "session.status": {
			const sessionID = ev.properties.sessionID as string;
			if (sessionID !== targetSessionId) return null;
			const status = ev.properties.status as { type: string };
			return {
				type: "session_status",
				status: status?.type === "idle" ? "idle" : "working",
			};
		}
		case "session.idle": {
			const sessionID = ev.properties.sessionID as string;
			if (sessionID !== targetSessionId) return null;
			return { type: "session_status", status: "idle" };
		}
		case "session.error": {
			const sessionID = ev.properties.sessionID as string | undefined;
			if (sessionID && sessionID !== targetSessionId) return null;
			return {
				type: "error",
				message: errorToString(ev.properties.error, "opencode session error"),
			};
		}
		default:
			return null;
	}
}

function normalizePartUpdate(
	part: OPart,
	delta: string | undefined,
	seenTextMessages: Set<string>,
): AgentStreamEvent | null {
	if (part.type === "text") {
		// Streaming text deltas take priority — they let the UI render the
		// model's text token-by-token as it arrives.
		if (typeof delta === "string" && delta.length > 0) {
			return { type: "token", messageId: part.messageID, chunk: delta };
		}
		// Opencode sometimes sends a part update with the FULL text and no
		// delta (e.g. for short non-streamed responses, or the user's echoed
		// prompt). Emit it once per messageId so the UI receives the text.
		const text = (part as { text?: string }).text ?? "";
		if (
			typeof text === "string" &&
			text.length > 0 &&
			!seenTextMessages.has(part.messageID)
		) {
			seenTextMessages.add(part.messageID);
			return { type: "token", messageId: part.messageID, chunk: text };
		}
		return null;
	}
	if (part.type === "tool") {
		return normalizeToolPart(part as OToolPart);
	}
	return null;
}

function normalizeToolPart(part: OToolPart): AgentStreamEvent | null {
	const state = part.state;
	switch (state.status) {
		case "pending":
		case "running":
			return {
				type: "tool_call_start",
				messageId: part.messageID,
				callId: part.callID,
				tool: part.tool,
				input: state.input,
			};
		case "completed":
			return {
				type: "tool_call_end",
				messageId: part.messageID,
				callId: part.callID,
				output: state.output,
			};
		case "error":
			return {
				type: "tool_call_end",
				messageId: part.messageID,
				callId: part.callID,
				output: state.error,
				error: state.error,
			};
		default:
			return null;
	}
}

/**
 * Coerce an opencode error payload (which may be a string, an Error-like
 * object with .message, an APIError-shaped {name, data:{message}}, or
 * anything else) into a single human-readable string. Never throws.
 */
function errorToString(value: unknown, fallback: string): string {
	if (value == null) return fallback;
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.message || fallback;
	if (typeof value === "object") {
		const v = value as Record<string, unknown>;
		if (typeof v.message === "string") return v.message;
		if (typeof v.error === "string") return v.error;
		if (v.data && typeof v.data === "object") {
			const d = v.data as Record<string, unknown>;
			if (typeof d.message === "string") return d.message;
		}
		try {
			return JSON.stringify(value);
		} catch {
			return fallback;
		}
	}
	return fallback;
}

function pickFreePort(): Promise<number> {
	return new Promise((res, rej) => {
		const s = net.createServer();
		s.unref();
		s.once("error", rej);
		s.listen(0, "127.0.0.1", () => {
			const addr = s.address();
			if (addr && typeof addr === "object") res(addr.port);
			else rej(new Error("no port"));
			s.close();
		});
	});
}

async function waitForReady(
	child: ReturnType<typeof spawn>,
	timeoutMs: number,
): Promise<string> {
	return await new Promise<string>((resolve, reject) => {
		let output = "";
		const timer = setTimeout(() => {
			cleanup();
			reject(
				new Error(
					`opencode serve did not become ready within ${timeoutMs}ms.\n${output}`,
				),
			);
		}, timeoutMs);
		const cleanup = () => clearTimeout(timer);
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			for (const line of output.split("\n")) {
				if (line.includes("opencode server listening")) {
					const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
					if (match?.[1]) {
						cleanup();
						resolve(match[1]);
						return;
					}
				}
			}
		});
		child.on("exit", (code) => {
			cleanup();
			reject(new Error(`opencode serve exited with code ${code}.\n${output}`));
		});
	});
}

function once(
	emitter: { once: (ev: string, cb: () => void) => void },
	event: string,
) {
	return new Promise<void>((resolve) => emitter.once(event, () => resolve()));
}
