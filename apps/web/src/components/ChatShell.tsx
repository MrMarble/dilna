import type {
	AgentStreamEvent,
	Message,
	MessagePart,
	SessionView,
} from "@dilna/shared";
import { LoaderCircle, Send, Square, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api/client";

type Props = {
	sessionId: string;
	session: SessionView;
};

type LiveMessage = {
	id: string;
	role: "user" | "assistant";
	parts: MessagePart[];
	text: string;
};

export function ChatShell({ sessionId, session }: Props) {
	const [messages, setMessages] = useState<Message[]>([]);
	const [live, setLive] = useState<Record<string, LiveMessage>>({});
	const [status, setStatus] = useState<SessionView["status"]>(session.status);
	const [input, setInput] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);

	const loadHistory = useCallback(async () => {
		try {
			const { messages } = await api.sessions.messages(sessionId);
			setMessages(messages);
			// Now that the persisted copies are in state, drop any live
			// messages that have already been persisted. Doing this AFTER
			// setMessages (not before) avoids the flicker where a message
			// is in neither state during the network round-trip.
			const persistedIds = new Set(messages.map((m) => m.id));
			setLive((prev) => {
				const next: Record<string, LiveMessage> = {};
				let changed = false;
				for (const [id, m] of Object.entries(prev)) {
					if (persistedIds.has(id)) {
						changed = true;
						continue;
					}
					next[id] = m;
				}
				return changed ? next : prev;
			});
		} catch (e) {
			setError(e instanceof Error ? e.message : "failed to load messages");
		}
	}, [sessionId]);

	useEffect(() => {
		setLive({});
		setMessages([]);
		setError(null);
		setStatus(session.status);
		loadHistory();
		const unsubscribe = api.sessions.stream(
			sessionId,
			(ev: AgentStreamEvent) => {
				switch (ev.type) {
					case "session_status":
						setStatus(ev.status);
						// Chat completed: refresh history. The loadHistory call
						// itself will drop live messages whose IDs are now persisted,
						// so there's no flicker gap between "live" and "persisted".
						if (ev.status === "idle" || ev.status === "crashed") {
							void loadHistory();
						}
						break;
					case "message_start":
						setLive((prev) => {
							if (prev[ev.messageId]) return prev;
							return {
								...prev,
								[ev.messageId]: {
									id: ev.messageId,
									role: ev.role,
									parts: [],
									text: "",
								},
							};
						});
						break;
					case "token":
						setLive((prev) => {
							const m = prev[ev.messageId];
							if (m) {
								return {
									...prev,
									[ev.messageId]: { ...m, text: m.text + ev.chunk },
								};
							}
							return {
								...prev,
								[ev.messageId]: {
									id: ev.messageId,
									role: "assistant",
									parts: [],
									text: ev.chunk,
								},
							};
						});
						break;
					case "tool_call_start":
						setLive((prev) => {
							const m = prev[ev.messageId];
							if (!m) return prev;
							return {
								...prev,
								[ev.messageId]: {
									...m,
									parts: [
										...m.parts,
										{
											type: "tool_call",
											callId: ev.callId,
											tool: ev.tool,
											input: ev.input,
											output: null,
											error: undefined,
										} as MessagePart,
									],
								},
							};
						});
						break;
					case "tool_call_end":
						setLive((prev) => {
							const m = prev[ev.messageId];
							if (!m) return prev;
							return {
								...prev,
								[ev.messageId]: {
									...m,
									parts: m.parts.map((p) =>
										p.type === "tool_call" && p.callId === ev.callId
											? { ...p, output: ev.output, error: ev.error }
											: p,
									),
								},
							};
						});
						break;
					case "message_end":
						// Backend doesn't currently emit message_end (opencode has
						// no such event), but if it ever does, just trigger a history
						// refresh — loadHistory itself drops persisted IDs from live.
						void loadHistory();
						break;
					case "error":
						setError(
							typeof ev.message === "string"
								? ev.message
								: JSON.stringify(ev.message),
						);
						break;
					case "agent_crashed":
						setError(
							`agent crashed (code ${ev.exitCode}). ${ev.stderrTail.slice(-3).join("; ")}`,
						);
						setStatus("crashed");
						break;
				}
			},
			() => void loadHistory(),
		);
		return unsubscribe;
	}, [sessionId, loadHistory, session.status]);

	// Reset status when session.status prop changes (sidebar refresh).
	useEffect(() => {
		setStatus(session.status);
	}, [session.status]);

	// Auto-scroll to bottom on new content.
	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [messages, live]);

	const working = status === "working" || status === "starting";

	const handleSend = useCallback(async () => {
		const text = input.trim();
		if (!text || sending || working) return;
		setInput("");
		setError(null);
		setSending(true);
		try {
			await api.sessions.send(sessionId, text);
		} catch (e) {
			setError(e instanceof Error ? e.message : "send failed");
		} finally {
			setSending(false);
		}
	}, [input, sending, working, sessionId]);

	const handleStop = useCallback(async () => {
		try {
			await api.sessions.stop(sessionId);
		} catch (e) {
			setError(e instanceof Error ? e.message : "stop failed");
		}
	}, [sessionId]);

	const rendered = useMemo(() => {
		const out: {
			id: string;
			role: "user" | "assistant";
			parts: MessagePart[];
		}[] = [];
		for (const m of messages) {
			out.push({ id: m.id, role: m.role, parts: m.parts });
		}
		for (const m of Object.values(live)) {
			const parts = [...m.parts];
			if (m.text) parts.unshift({ type: "text", text: m.text });
			if (parts.length === 0) continue;
			out.push({ id: m.id, role: m.role, parts });
		}
		return out;
	}, [messages, live]);

	return (
		<div className="flex h-full flex-col">
			<div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-4">
				{rendered.length === 0 ? (
					<div className="flex h-full flex-col items-center justify-center text-muted-foreground">
						<p className="text-sm">No messages yet.</p>
						<p className="mt-1 text-xs">Ask the agent something below.</p>
					</div>
				) : (
					<ul className="mx-auto max-w-3xl space-y-3">
						{rendered.map((m) => (
							<li
								key={m.id}
								className={
									m.role === "user"
										? "rounded-md bg-zinc-100 px-3 py-2 dark:bg-zinc-900"
										: "rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800"
								}
							>
								<div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">
									{m.role}
								</div>
								<MessageBody parts={m.parts} />
							</li>
						))}
					</ul>
				)}
				{error && (
					<p className="mx-auto mt-3 max-w-3xl rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-400">
						{error}
					</p>
				)}
			</div>

			<div className="border-t border-zinc-200 px-6 py-3 dark:border-zinc-800">
				<div className="mx-auto flex max-w-3xl items-end gap-2">
					<textarea
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								void handleSend();
							}
						}}
						disabled={working && !input}
						placeholder={working ? "Agent is working…" : "Send a message…"}
						rows={1}
						className="flex-1 resize-none rounded-md border border-zinc-300 bg-transparent px-3 py-2 text-sm outline-none focus:border-zinc-400 dark:border-zinc-700 dark:focus:border-zinc-500"
					/>
					{working ? (
						<button
							type="button"
							onClick={handleStop}
							className="flex items-center gap-1 rounded-md border border-zinc-300 bg-zinc-100 px-3 py-2 text-sm font-medium hover:bg-zinc-200 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"
						>
							<Square className="size-3.5" />
							Stop
						</button>
					) : (
						<button
							type="button"
							onClick={handleSend}
							disabled={!input.trim() || sending}
							className="flex items-center gap-1 rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-50 hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
						>
							{sending ? (
								<LoaderCircle className="size-3.5 animate-spin" />
							) : (
								<Send className="size-3.5" />
							)}
							Send
						</button>
					)}
				</div>
				<p className="mx-auto mt-1 max-w-3xl text-xs text-muted-foreground">
					Enter to send, Shift+Enter for newline.
				</p>
			</div>
		</div>
	);
}

function MessageBody({ parts }: { parts: MessagePart[] }) {
	return (
		<div className="space-y-2 text-sm">
			{parts.map((p, i) => {
				if (p.type === "text") {
					return (
						<pre key={i} className="whitespace-pre-wrap break-words font-sans">
							{p.text}
						</pre>
					);
				}
				if (p.type === "tool_call") {
					return <ToolCall key={i} part={p} />;
				}
				return null;
			})}
		</div>
	);
}

function ToolCall({
	part,
}: {
	part: Extract<MessagePart, { type: "tool_call" }>;
}) {
	const output =
		part.error != null
			? String(part.error)
			: part.output != null && part.output !== ""
				? String(part.output)
				: "";
	return (
		<div className="rounded-md border border-zinc-200 bg-zinc-50 px-2 py-1.5 text-xs dark:border-zinc-800 dark:bg-zinc-950">
			<div className="flex items-center gap-1.5 font-mono">
				<Wrench className="size-3 text-muted-foreground" />
				<span className="font-medium">{part.tool}</span>
			</div>
			{typeof part.input === "object" && part.input !== null && (
				<pre className="mt-1 overflow-x-auto text-zinc-600 dark:text-zinc-400">
					{JSON.stringify(part.input)}
				</pre>
			)}
			{output && (
				<pre className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap text-zinc-600 dark:text-zinc-400">
					{output}
				</pre>
			)}
		</div>
	);
}
