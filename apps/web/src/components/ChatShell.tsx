import type {
	AgentStreamEvent,
	Message as ChatMessage,
	MessagePart,
	SessionView,
} from "@dilna/shared";
import { AlertCircle, LoaderCircle, Send, Square, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import { Message, MessageContent } from "@/components/ui/message";
import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerProvider,
	MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";

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
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [live, setLive] = useState<Record<string, LiveMessage>>({});
	const [status, setStatus] = useState<SessionView["status"]>(session.status);
	const [input, setInput] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** True from send → first assistant token/tool_call; suppresses the
	 * 'Thinking...' marker once content starts streaming. */
	const [thinking, setThinking] = useState(false);

	const loadHistory = useCallback(async () => {
		try {
			const { messages } = await api.sessions.messages(sessionId);
			setMessages(messages);
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
		setThinking(false);
		setStatus(session.status);
		loadHistory();
		const unsubscribe = api.sessions.stream(
			sessionId,
			(ev: AgentStreamEvent) => {
				switch (ev.type) {
					case "session_status":
						setStatus(ev.status);
						if (ev.status === "idle" || ev.status === "crashed") {
							void loadHistory();
							if (ev.status === "crashed") setThinking(false);
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
						// Deactivate the thinking throbber the moment the
						// assistant produces any token (text or otherwise).
						setThinking(false);
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
						setThinking(false);
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
						void loadHistory();
						break;
					case "error":
						setThinking(false);
						setError(
							typeof ev.message === "string"
								? ev.message
								: JSON.stringify(ev.message),
						);
						break;
					case "agent_crashed":
						setThinking(false);
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

	useEffect(() => {
		setStatus(session.status);
	}, [session.status]);

	const working = status === "working" || status === "starting";

	const handleSend = useCallback(async () => {
		const text = input.trim();
		if (!text || sending || working) return;
		setInput("");
		setError(null);
		setSending(true);
		setThinking(true);
		try {
			await api.sessions.send(sessionId, text);
		} catch (e) {
			setError(e instanceof Error ? e.message : "send failed");
			setThinking(false);
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
			<div className="flex-1 overflow-hidden">
				<MessageScrollerProvider autoScroll>
					<MessageScroller className="h-full">
						<MessageScrollerViewport>
							<MessageScrollerContent className="p-4">
								{rendered.length === 0 && !thinking ? (
									<EmptyHint />
								) : (
									<>
										{rendered.map((m) => (
											<MessageScrollerItem
												key={m.id}
												messageId={m.id}
												scrollAnchor={m.role === "user"}
											>
												<ChatMessageRow
													id={m.id}
													role={m.role}
													parts={m.parts}
												/>
											</MessageScrollerItem>
										))}
										{thinking && <ThinkingMarker />}
										{error && (
											<MessageScrollerItem messageId="__error">
												<Marker
													variant="border"
													className="text-red-500 dark:text-red-400"
												>
													<MarkerIcon>
														<AlertCircle className="size-4" />
													</MarkerIcon>
													<MarkerContent className="text-red-500 dark:text-red-400">
														{error}
													</MarkerContent>
												</Marker>
											</MessageScrollerItem>
										)}
									</>
								)}
							</MessageScrollerContent>
						</MessageScrollerViewport>
						<MessageScrollerButton />
					</MessageScroller>
				</MessageScrollerProvider>
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

function EmptyHint() {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
			<p className="text-sm">No messages yet.</p>
			<p className="text-xs">Ask the agent something below.</p>
		</div>
	);
}

function ThinkingMarker() {
	return (
		<MessageScrollerItem messageId="__thinking">
			<Marker role="status">
				<MarkerIcon>
					<Spinner />
				</MarkerIcon>
				<MarkerContent className="shimmer">Thinking...</MarkerContent>
			</Marker>
		</MessageScrollerItem>
	);
}

function ChatMessageRow({
	id,
	role,
	parts,
}: {
	id: string;
	role: "user" | "assistant";
	parts: MessagePart[];
}) {
	const align = role === "user" ? "end" : "start";
	const bubbleVariant = role === "user" ? "default" : "muted";

	// Separate text parts (rendered as Bubble rows) from tool parts (rendered
	// as Marker rows). Order is preserved.
	const rows: React.ReactNode[] = [];
	parts.forEach((p, i) => {
		if (p.type === "text") {
			rows.push(
				<Bubble key={`t-${i}`} variant={bubbleVariant}>
					<BubbleContent>
						<pre className="whitespace-pre-wrap break-words font-sans text-sm">
							{p.text}
						</pre>
					</BubbleContent>
				</Bubble>,
			);
		} else if (p.type === "tool_call") {
			rows.push(<ToolCallMarker key={`c-${i}`} part={p} />);
		}
	});

	return (
		<Message align={align}>
			<MessageContent>
				{rows.length > 0 ? (
					rows
				) : (
					<span className="text-xs text-muted-foreground">{id}</span>
				)}
			</MessageContent>
		</Message>
	);
}

function ToolCallMarker({
	part,
}: {
	part: Extract<MessagePart, { type: "tool_call" }>;
}) {
	// Indented inline marker inside the assistant message. Pending/running
	// tools get a spinner; completed tools show their output below the call.
	const running = part.output == null && part.error == null;
	const output =
		part.error != null
			? String(part.error)
			: part.output != null && part.output !== ""
				? String(part.output)
				: "";
	return (
		<Marker variant="border">
			<MarkerIcon>
				{running ? <Spinner /> : <Wrench className="size-4" />}
			</MarkerIcon>
			<MarkerContent>
				<div className="flex flex-col gap-1">
					<div className="flex items-center gap-1.5 font-mono text-xs">
						<span className="font-medium text-muted-foreground">
							{part.tool}
						</span>
						<span className="text-muted-foreground">
							{running ? "running…" : "done"}
						</span>
					</div>
					{typeof part.input === "object" && part.input !== null && (
						<pre className="overflow-x-auto rounded bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
							{JSON.stringify(part.input)}
						</pre>
					)}
					{output && (
						<pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
							{output}
						</pre>
					)}
				</div>
			</MarkerContent>
		</Marker>
	);
}
