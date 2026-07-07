import type {
	Message as ChatMessage,
	MessagePart,
	SessionView,
} from "@dilna/shared";
import {
	AlertCircle,
	ChevronDown,
	ChevronRight,
	LoaderCircle,
	Send,
	Square,
	Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

	// Optimistic user message IDs whose first token should set (not append) text.
	const optimisticIdsRef = useRef(new Set<string>());

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
		// Fetch history once on mount; live events keep us up-to-date after that.
		loadHistory();
		const unsubscribe = api.sessions.stream(sessionId, (ev) => {
			switch (ev.type) {
				case "session_status":
					setStatus(ev.status);
					if (ev.status === "crashed") {
						setThinking(false);
					}
					if (ev.status === "idle" || ev.status === "crashed") {
						setLive((currentLive) => {
							const entries = Object.entries(currentLive);
							if (entries.length === 0) return currentLive;
							const liveIds = new Set(entries.map(([k]) => k));
							setMessages((prev) => {
								const kept = prev.filter((m) => !liveIds.has(m.id));
								const newMsgs = entries.map(([, m]) => {
									const parts = [...m.parts];
									if (m.text) parts.unshift({ type: "text", text: m.text });
									return {
										id: m.id,
										sessionId,
										role: m.role,
										parts,
										createdAt: Math.floor(Date.now() / 1000),
									};
								});
								return [...kept, ...newMsgs];
							});
							return {};
						});
					}
					break;
				case "message_start":
					setLive((prev) => {
						if (prev[ev.messageId]) return prev;
						const next = { ...prev };
						for (const [key, entry] of Object.entries(next)) {
							if (key.startsWith("temp-") && entry.role === "user") {
								optimisticIdsRef.current.delete(key);
								const text = entry.text;
								delete next[key];
								next[ev.messageId] = {
									id: ev.messageId,
									role: ev.role,
									parts: [],
									text,
								};
								optimisticIdsRef.current.add(ev.messageId);
								return next;
							}
						}
						next[ev.messageId] = {
							id: ev.messageId,
							role: ev.role,
							parts: [],
							text: "",
						};
						return next;
					});
					break;
				case "token":
					setThinking(false);
					setLive((prev) => {
						const m = prev[ev.messageId];
						if (m) {
							if (optimisticIdsRef.current.has(ev.messageId)) {
								optimisticIdsRef.current.delete(ev.messageId);
								return {
									...prev,
									[ev.messageId]: { ...m, text: ev.chunk },
								};
							}
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
		});
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

		// Optimistic user message placeholder — visible immediately so autoscroll
		// follows it. The real message_start event will replace the temp ID.
		const tempId = `temp-${Date.now()}`;
		optimisticIdsRef.current.add(tempId);
		setLive((prev) => ({
			...prev,
			[tempId]: { id: tempId, role: "user", parts: [], text },
		}));

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
		const liveIds = new Set(Object.keys(live));
		const out: {
			id: string;
			role: "user" | "assistant";
			parts: MessagePart[];
		}[] = [];
		// Persisted messages — skip any that have a live counterpart.
		for (const m of messages) {
			if (liveIds.has(m.id)) continue;
			out.push({ id: m.id, role: m.role, parts: m.parts });
		}
		// Live messages — their text field may contain streamed content.
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

	// Group consecutive tool call parts into collapsible sections.
	const rows: React.ReactNode[] = [];
	let toolBuffer: Extract<MessagePart, { type: "tool_call" }>[] = [];
	function flushTools() {
		if (toolBuffer.length > 0) {
			rows.push(<ToolCallGroup key={`g-${rows.length}`} parts={toolBuffer} />);
			toolBuffer = [];
		}
	}
	parts.forEach((p, i) => {
		if (p.type === "text") {
			flushTools();
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
			toolBuffer.push(p);
		}
	});
	flushTools();

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

function ToolCallGroup({
	parts,
}: {
	parts: Extract<MessagePart, { type: "tool_call" }>[];
}) {
	const [expanded, setExpanded] = useState(false);
	const running = parts.some((p) => p.output == null && p.error == null);
	const count = parts.length;

	return (
		<Marker variant="border">
			<MarkerIcon>
				{running ? <Spinner /> : <Wrench className="size-4" />}
			</MarkerIcon>
			<MarkerContent>
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					className="flex cursor-pointer items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
				>
					{expanded ? (
						<ChevronDown className="size-3" />
					) : (
						<ChevronRight className="size-3" />
					)}
					{running
						? "Running tools…"
						: `${count} tool call${count > 1 ? "s" : ""}`}
				</button>
				{expanded && (
					<div className="mt-2 flex flex-col gap-2">
						{parts.map((p) => (
							<ToolCallMarker key={p.callId} part={p} compact />
						))}
					</div>
				)}
			</MarkerContent>
		</Marker>
	);
}

function ToolCallMarker({
	part,
	compact,
}: {
	part: Extract<MessagePart, { type: "tool_call" }>;
	compact?: boolean;
}) {
	const running = part.output == null && part.error == null;
	const output =
		part.error != null
			? String(part.error)
			: part.output != null && part.output !== ""
				? String(part.output)
				: "";
	return (
		<Marker variant={compact ? "default" : "border"}>
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
					{!compact &&
						typeof part.input === "object" &&
						part.input !== null && (
							<pre className="overflow-x-auto rounded bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
								{JSON.stringify(part.input)}
							</pre>
						)}
					{!compact && output && (
						<pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
							{output}
						</pre>
					)}
				</div>
			</MarkerContent>
		</Marker>
	);
}
