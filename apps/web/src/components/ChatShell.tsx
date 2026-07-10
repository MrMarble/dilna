import type {
	AgentType,
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
	User,
	Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/api/client";
import { Markdown } from "@/components/ui/markdown";
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker";
import {
	Message,
	MessageContent,
	MessageHeader,
} from "@/components/ui/message";
import {
	MessageScroller,
	MessageScrollerButton,
	MessageScrollerContent,
	MessageScrollerItem,
	MessageScrollerProvider,
	MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Spinner } from "@/components/ui/spinner";
import { AgentIcon } from "@/lib/agent-icons";
import { AGENT_LABELS } from "@/lib/agent-labels";
import { getToolMeta } from "@/lib/tool-meta";
import { cn } from "@/lib/utils";

type Props = {
	sessionId: string;
	session: SessionView;
	/** Desktop viewports get Enter-to-send (Shift+Enter for a newline);
	 * mobile keyboards don't reliably expose Shift, so Enter inserts a
	 * newline there instead and the Send button submits. */
	isDesktop: boolean;
};

type LiveMessage = {
	id: string;
	role: "user" | "assistant";
	/** Text and tool_call parts in the order they actually streamed in, so
	 * live rendering matches the interleaving persisted after the turn. */
	parts: MessagePart[];
	/** Epoch seconds this message started streaming — used for the
	 * attribution timestamp before it's persisted with a real createdAt. */
	startedAt: number;
};

function nowSeconds() {
	return Math.floor(Date.now() / 1000);
}

/** Rotating gerunds shown while the agent works (composer placeholder and
 * the in-chat thinking marker), instead of a static "Agent is working". */
const THINKING_WORDS = [
	"Pondering",
	"Percolating",
	"Ruminating",
	"Marinating",
	"Cogitating",
	"Noodling",
	"Mulling",
	"Simmering",
	"Brewing",
	"Whirring",
	"Tinkering",
	"Conjuring",
	"Scheming",
	"Puzzling",
];

function pickThinkingWord(): string {
	return (
		THINKING_WORDS[Math.floor(Math.random() * THINKING_WORDS.length)] ??
		"Thinking"
	);
}

function formatClockTime(epochSeconds: number) {
	return new Date(epochSeconds * 1000).toLocaleTimeString([], {
		hour: "numeric",
		minute: "2-digit",
	});
}

export function ChatShell({ sessionId, session, isDesktop }: Props) {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [live, setLive] = useState<Record<string, LiveMessage>>({});
	const [status, setStatus] = useState<SessionView["status"]>(session.status);
	const [input, setInput] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** True from send → first assistant token/tool_call; suppresses the
	 * 'Thinking...' marker once content starts streaming. */
	const [thinking, setThinking] = useState(false);

	// True once a turn has run on this subscription — gates the idle-time
	// history reconcile so the subscribe-time idle snapshot doesn't refetch.
	const sawTurnRef = useRef(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// Auto-grow the composer between 2 and 4 lines; beyond that it scrolls
	// internally instead of pushing the rest of the page around.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `input` isn't read directly, but the textarea must be re-measured after every keystroke re-renders it.
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) return;
		const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight) || 20;
		const minHeight = lineHeight * 2;
		const maxHeight = lineHeight * 4;
		el.style.height = "auto";
		const next = Math.min(Math.max(el.scrollHeight, minHeight), maxHeight);
		el.style.height = `${next}px`;
		el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
	}, [input]);

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

	// Keyed on sessionId only — deliberately NOT session.status: re-running
	// this effect mid-turn (as a status flip used to) wipes the live entries
	// and re-fetches history while the turn's rows are still provisional,
	// which is how messages briefly rendered out of order.
	useEffect(() => {
		setLive({});
		setMessages([]);
		setError(null);
		setThinking(false);
		sawTurnRef.current = false;
		// Fetch history once on mount; live events keep us up-to-date after
		// that, and the idle-time reconcile re-syncs after each turn.
		loadHistory();
		const unsubscribe = api.sessions.stream(sessionId, (ev) => {
			switch (ev.type) {
				case "session_status":
					setStatus(ev.status);
					if (ev.status === "working" || ev.status === "starting") {
						sawTurnRef.current = true;
					}
					if (ev.status === "crashed") {
						setThinking(false);
					}
					if (ev.status === "idle" || ev.status === "crashed") {
						// Flush live entries into the local list so nothing flickers,
						// then reconcile against the DB — the source of truth (ADR-0004):
						// authoritative rows replace the flushed copies' provisional
						// ids/timestamps, and the optimistic temp user entry (whose
						// content the server persisted at send time) drops out.
						setLive((currentLive) => {
							const entries = Object.entries(currentLive);
							if (entries.length === 0) return currentLive;
							const liveIds = new Set(entries.map(([k]) => k));
							setMessages((prev) => {
								const kept = prev.filter((m) => !liveIds.has(m.id));
								const newMsgs = entries.map(([, m]) => ({
									id: m.id,
									sessionId,
									role: m.role,
									parts: m.parts,
									createdAt: m.startedAt,
								}));
								return [...kept, ...newMsgs];
							});
							return {};
						});
						if (sawTurnRef.current) {
							sawTurnRef.current = false;
							loadHistory();
						}
					}
					break;
				case "message_start":
					// Always a new assistant turn message (claude.ts never emits
					// user-role starts); the optimistic temp user entry stays in
					// place until the idle-time reconcile swaps in the DB rows.
					setLive((prev) => {
						if (prev[ev.messageId]) return prev;
						return {
							...prev,
							[ev.messageId]: {
								id: ev.messageId,
								role: ev.role,
								parts: [],
								startedAt: nowSeconds(),
							},
						};
					});
					break;
				case "token":
					setThinking(false);
					setLive((prev) => {
						const m = prev[ev.messageId];
						if (m) {
							// Append to the trailing text part so streamed chunks join up;
							// start a new part if the turn just returned from a tool call,
							// preserving the real text/tool_call interleaving order.
							const last = m.parts[m.parts.length - 1];
							const parts: MessagePart[] =
								last?.type === "text"
									? [
											...m.parts.slice(0, -1),
											{ type: "text", text: last.text + ev.chunk },
										]
									: [...m.parts, { type: "text", text: ev.chunk }];
							return { ...prev, [ev.messageId]: { ...m, parts } };
						}
						return {
							...prev,
							[ev.messageId]: {
								id: ev.messageId,
								role: "assistant",
								parts: [{ type: "text", text: ev.chunk }],
								startedAt: nowSeconds(),
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
	}, [sessionId, loadHistory]);

	useEffect(() => {
		setStatus(session.status);
	}, [session.status]);

	const working = status === "working" || status === "starting";

	// New word each time the agent starts working, stable while it runs.
	const [thinkingWord, setThinkingWord] = useState(pickThinkingWord);
	useEffect(() => {
		if (working) setThinkingWord(pickThinkingWord());
	}, [working]);

	const handleSend = useCallback(async () => {
		const text = input.trim();
		if (!text || sending || working) return;
		setInput("");
		setError(null);
		setSending(true);
		setThinking(true);

		// Optimistic user message placeholder — visible immediately so autoscroll
		// follows it; replaced by the authoritative DB row at the idle reconcile.
		const tempId = `temp-${Date.now()}`;
		setLive((prev) => ({
			...prev,
			[tempId]: {
				id: tempId,
				role: "user",
				parts: [{ type: "text", text }],
				startedAt: nowSeconds(),
			},
		}));

		try {
			await api.sessions.send(sessionId, text);
		} catch (e) {
			setError(e instanceof Error ? e.message : "send failed");
			setThinking(false);
			// The message never reached the server — withdraw the optimistic
			// entry instead of leaving a bubble the agent never saw.
			setLive((prev) => {
				if (!(tempId in prev)) return prev;
				const next = { ...prev };
				delete next[tempId];
				return next;
			});
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
			createdAt: number;
		}[] = [];
		// Persisted messages — skip any that have a live counterpart.
		for (const m of messages) {
			if (liveIds.has(m.id)) continue;
			out.push({
				id: m.id,
				role: m.role,
				parts: m.parts,
				createdAt: m.createdAt,
			});
		}
		// Live messages — parts already carry streamed content in stream order.
		for (const m of Object.values(live)) {
			if (m.parts.length === 0) continue;
			out.push({
				id: m.id,
				role: m.role,
				parts: m.parts,
				createdAt: m.startedAt,
			});
		}
		return out;
	}, [messages, live]);

	return (
		<div className="flex h-full flex-col">
			<div className="flex-1 overflow-hidden">
				<MessageScrollerProvider autoScroll>
					<MessageScroller className="h-full">
						<MessageScrollerViewport>
							<MessageScrollerContent className="mx-auto w-full max-w-[max(48rem,80%)] px-6 pt-5 pb-8">
								{rendered.length === 0 && !thinking ? (
									<EmptyHint />
								) : (
									<>
										{rendered.map((m, i) => (
											<MessageScrollerItem key={m.id} messageId={m.id}>
												<ChatMessageRow
													id={m.id}
													role={m.role}
													parts={m.parts}
													createdAt={m.createdAt}
													showAttribution={
														i === 0 || rendered[i - 1]?.role !== m.role
													}
													agentType={session.agentType}
												/>
											</MessageScrollerItem>
										))}
										{thinking && <ThinkingMarker word={thinkingWord} />}
										{error && (
											<MessageScrollerItem messageId="__error">
												<Marker variant="border" className="text-destructive">
													<MarkerIcon>
														<AlertCircle className="size-4" />
													</MarkerIcon>
													<MarkerContent className="text-destructive">
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

			<div className="px-6 py-4">
				<div className="mx-auto flex max-w-[max(48rem,80%)] items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 shadow-sm transition-colors focus-within:border-ring/60">
					<textarea
						ref={textareaRef}
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => {
							// On desktop, Enter sends and Shift+Enter inserts a newline.
							// Mobile keyboards don't reliably expose Shift, so there
							// Enter just inserts a newline and the Send button submits.
							if (isDesktop && e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								void handleSend();
							}
						}}
						disabled={working && !input}
						placeholder={
							working
								? `${thinkingWord}…`
								: `Message ${AGENT_LABELS[session.agentType]}…`
						}
						rows={2}
						className="flex-1 resize-none bg-transparent px-1 py-1.5 text-base outline-none"
					/>
					{working ? (
						<button
							type="button"
							onClick={handleStop}
							className="flex size-8 shrink-0 items-center justify-center self-center rounded-lg border border-border transition-colors hover:bg-accent active:scale-[0.97]"
							title="Stop"
						>
							<Square className="size-3.5" />
						</button>
					) : (
						<button
							type="button"
							onClick={handleSend}
							disabled={!input.trim() || sending}
							className="flex size-8 shrink-0 items-center justify-center self-center rounded-lg bg-primary text-primary-foreground transition-[background-color,scale] hover:bg-primary/90 active:scale-[0.97] disabled:opacity-40"
							title="Send"
						>
							{sending ? (
								<LoaderCircle className="size-3.5 animate-spin" />
							) : (
								<Send className="size-3.5" />
							)}
						</button>
					)}
				</div>
				<p className="mx-auto mt-1.5 max-w-[max(48rem,80%)] text-center text-xs text-muted-foreground">
					{isDesktop
						? "Enter to send, Shift+Enter for newline."
						: "Enter for newline, tap Send to submit."}
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

function ThinkingMarker({ word }: { word: string }) {
	return (
		<MessageScrollerItem messageId="__thinking">
			<Marker role="status">
				<MarkerIcon>
					<Spinner />
				</MarkerIcon>
				<MarkerContent className="shimmer">{word}…</MarkerContent>
			</Marker>
		</MessageScrollerItem>
	);
}

function ChatMessageRow({
	id,
	role,
	parts,
	createdAt,
	showAttribution,
	agentType,
}: {
	id: string;
	role: "user" | "assistant";
	parts: MessagePart[];
	createdAt: number;
	showAttribution: boolean;
	agentType: AgentType;
}) {
	const name = role === "user" ? "You" : AGENT_LABELS[agentType];

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
				// biome-ignore lint/suspicious/noArrayIndexKey: parts have no ids; the list is append-only within a message, so positional keys are stable.
				<div key={`t-${i}`} className="text-base leading-relaxed">
					{role === "assistant" ? (
						<Markdown>{p.text}</Markdown>
					) : (
						<pre className="whitespace-pre-wrap break-words font-sans">
							{p.text}
						</pre>
					)}
				</div>,
			);
		} else if (p.type === "tool_call") {
			toolBuffer.push(p);
		}
	});
	flushTools();

	return (
		<Message className="group/message gap-3">
			<div className="flex w-8 shrink-0 justify-center self-start">
				{showAttribution && (
					<span className="flex size-7 items-center justify-center rounded-full bg-muted">
						{role === "user" ? (
							<User className="size-4" />
						) : (
							<AgentIcon agentType={agentType} className="size-4" />
						)}
					</span>
				)}
			</div>
			<MessageContent>
				{showAttribution ? (
					<MessageHeader className="items-baseline gap-2 px-0">
						<span className="text-lg font-semibold leading-tight text-foreground">
							{name}
						</span>
						<span className="text-xs tabular-nums">
							{formatClockTime(createdAt)}
						</span>
					</MessageHeader>
				) : (
					<MessageHeader className="gap-1.5 px-0 invisible text-xs tabular-nums group-hover/message:visible">
						<span>{formatClockTime(createdAt)}</span>
					</MessageHeader>
				)}
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
	const running = parts.some((p) => p.output == null && p.error == null);
	// Live-streaming groups mount open so the user sees tools as they run;
	// history (mounted after the fact) starts collapsed.
	const [expanded, setExpanded] = useState(running);
	const count = parts.length;
	const labels = [
		...new Set(parts.map((p) => getToolMeta(p.tool, p.input).label)),
	];

	return (
		<Marker className="rounded-lg border border-border bg-muted/30 px-3 py-2">
			<MarkerIcon>
				{running ? <Spinner /> : <Wrench className="size-4" />}
			</MarkerIcon>
			<MarkerContent>
				<button
					type="button"
					onClick={() => setExpanded((v) => !v)}
					className="flex w-full cursor-pointer items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
				>
					{expanded ? (
						<ChevronDown className="size-3" />
					) : (
						<ChevronRight className="size-3" />
					)}
					{count} tool call{count > 1 ? "s" : ""}
					{running ? "…" : ""}
					{!expanded && (
						<span className="truncate font-normal">— {labels.join(", ")}</span>
					)}
				</button>
				{expanded && (
					<div className="mt-2 flex flex-col gap-1.5">
						{parts.map((p) => (
							<ToolCallMarker key={p.callId} part={p} />
						))}
					</div>
				)}
			</MarkerContent>
		</Marker>
	);
}

function ToolCallMarker({
	part,
}: {
	part: Extract<MessagePart, { type: "tool_call" }>;
}) {
	const [open, setOpen] = useState(false);
	const running = part.output == null && part.error == null;
	const failed = part.error != null;
	const meta = getToolMeta(part.tool, part.input);
	const Icon = meta.icon;
	const output =
		part.error != null
			? String(part.error)
			: part.output != null && part.output !== ""
				? String(part.output)
				: "";

	const input = (
		part.input !== null && typeof part.input === "object" ? part.input : {}
	) as Record<string, unknown>;
	const isEdit =
		(part.tool === "Edit" || part.tool === "MultiEdit") &&
		typeof input.old_string === "string" &&
		typeof input.new_string === "string";
	// Unknown tools get no detail line, so the raw input is the only context.
	const showRawInput =
		meta.detail === undefined && Object.keys(input).length > 0;
	const hasDetails = isEdit || showRawInput || output.length > 0;

	return (
		<div className="rounded-md border border-border bg-card">
			<button
				type="button"
				onClick={() => hasDetails && setOpen((v) => !v)}
				className={cn(
					"flex w-full items-center gap-2 px-2.5 py-1.5 text-left",
					hasDetails && "cursor-pointer hover:bg-accent/30",
				)}
			>
				{running ? (
					<Spinner className="size-3.5 shrink-0" />
				) : (
					<Icon className="size-3.5 shrink-0 text-muted-foreground" />
				)}
				<span className="shrink-0 text-xs font-medium">{meta.label}</span>
				{meta.detail && (
					<span
						className="truncate font-mono text-xs text-muted-foreground"
						title={meta.detail}
					>
						{meta.detail}
					</span>
				)}
				<span className="ml-auto flex shrink-0 items-center text-xs text-muted-foreground">
					{failed ? (
						<span className="text-destructive">failed</span>
					) : (
						hasDetails &&
						(open ? (
							<ChevronDown className="size-3" />
						) : (
							<ChevronRight className="size-3" />
						))
					)}
				</span>
			</button>
			{open && hasDetails && (
				<div className="flex flex-col gap-1 border-t border-border px-2.5 py-1.5">
					{isEdit && (
						<>
							<pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-red-500/10 px-2 py-1 text-xs text-red-700 dark:text-red-300">
								{String(input.old_string)}
							</pre>
							<pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-emerald-500/10 px-2 py-1 text-xs text-emerald-700 dark:text-emerald-300">
								{String(input.new_string)}
							</pre>
						</>
					)}
					{showRawInput && (
						<pre className="overflow-x-auto rounded bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
							{JSON.stringify(input)}
						</pre>
					)}
					{output && (
						<pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
							{output}
						</pre>
					)}
				</div>
			)}
		</div>
	);
}
