import {
	type AgentStreamEvent,
	type AgentType,
	type Attachment,
	type Message as ChatMessage,
	formatAttachmentSize,
	type MessagePart,
	type SessionView,
} from "@dilna/shared";
import {
	AlertCircle,
	ChevronDown,
	ChevronRight,
	FileText,
	Info,
	ListTree,
	LoaderCircle,
	Plus,
	Send,
	Square,
	User,
	Wrench,
	X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, attachmentUrl } from "@/api/client";
import { CopyButton } from "@/components/ui/copy-button";
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
import {
	MAX_ATTACHMENTS,
	type PendingAttachment,
	usePendingAttachments,
} from "@/hooks/usePendingAttachments";
import { AgentIcon } from "@/lib/agent-icons";
import { assistantDisplayName } from "@/lib/agent-labels";
import {
	applyEventToLive,
	type LiveMessage,
	mergeRenderedMessages,
	nowSeconds,
} from "@/lib/live-messages";
import { partsToMarkdown } from "@/lib/message-markdown";
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

/** The in-turn feedback snapshot (ADR-0016 §5) — level-based, valid only
 * inside a turn: cleared on any terminal status, never re-derived from it. */
type TurnActivity = Extract<AgentStreamEvent, { type: "turn_activity" }>;

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

/** Elapsed seconds since `startedAt` (ms), corrected for clock skew against
 * `turn_activity`'s `serverTime` (ADR-0016 §5) rather than the client's own
 * clock, which may be off from the server's. */
function elapsedSeconds(startedAt: number, serverTime: number): number {
	const skew = Date.now() - serverTime;
	return Math.max(0, Math.round((Date.now() - skew - startedAt) / 1000));
}

const PHASE_LABEL: Record<string, string> = {
	requesting: "Requesting…",
	compacting: "Compacting context…",
	retrying: "Retrying…",
};

export function ChatShell({ sessionId, session, isDesktop }: Props) {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [live, setLive] = useState<Record<string, LiveMessage>>({});
	const [status, setStatus] = useState<SessionView["status"]>(session.status);
	const [input, setInput] = useState("");
	const [sending, setSending] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** Transient degraded-not-failed line (ADR-0016 §2's `notice`) — separate
	 * from `error` so it renders as an unobtrusive line, not a destructive one. */
	const [notice, setNotice] = useState<string | null>(null);
	/** True from send → first assistant token/tool_call; suppresses the
	 * 'Thinking...' marker once content starts streaming. */
	const [thinking, setThinking] = useState(false);
	/** In-turn feedback snapshot (ADR-0016 §5) — replaced wholesale on every
	 * `turn_activity`, cleared on any terminal status. */
	const [turnActivity, setTurnActivity] = useState<TurnActivity | null>(null);
	/** Per-message `thinking` chunk buffers — transient, mirrors `token`'s
	 * buffering but never persisted; cleared at that message's `message_end`. */
	const [thinkingBuffers, setThinkingBuffers] = useState<
		Record<string, string>
	>({});
	/** ~3s-debounced "reconnecting…" pill (ADR-0016 §4) — nothing shows while
	 * healthy, and recovery clears it instantly. */
	const [degraded, setDegraded] = useState(false);

	// True once turn activity (a status flip to working, or any mid-turn
	// content event — which is all a tab joining mid-turn ever sees) has hit
	// this subscription — gates the idle-time history reconcile so the
	// subscribe-time idle snapshot doesn't refetch.
	const sawTurnRef = useRef(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const { pending, addFiles, removePending, clearPending } =
		usePendingAttachments(sessionId);

	/** The tray entries a send can actually reference — uploaded, with a
	 * server id. Errored and still-uploading entries are excluded, so this is
	 * both what gets sent and what "is there anything to send?" is measured
	 * against. */
	const readyToSend = useMemo(
		() =>
			pending.flatMap((p) =>
				p.status === "done" && p.attachment ? [p.attachment] : [],
			),
		[pending],
	);

	/** Paste-to-attach: a clipboard image (the usual screenshot path) becomes
	 * an attachment instead of nothing. Pasted *text* is left entirely alone —
	 * `clipboardData.files` is empty for it, so the default paste runs. */
	const handlePaste = useCallback(
		(e: React.ClipboardEvent<HTMLTextAreaElement>) => {
			const files = Array.from(e.clipboardData.files);
			if (files.length === 0) return;
			e.preventDefault();
			void addFiles(files);
		},
		[addFiles],
	);

	/** Drag-and-drop onto the composer (issue #53's "drag a file/image into
	 * the prompt"). Counted rather than toggled: dragging over a child element
	 * fires `dragleave` on the parent, so a boolean flickers the highlight off
	 * mid-drag. */
	const [dragDepth, setDragDepth] = useState(0);
	const handleDrop = useCallback(
		(e: React.DragEvent) => {
			const files = Array.from(e.dataTransfer.files);
			setDragDepth(0);
			// Only claim the drop when it actually carries files — dragged text
			// should still land in the textarea as text.
			if (files.length === 0) return;
			e.preventDefault();
			void addFiles(files);
		},
		[addFiles],
	);

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

	// The one on-open routine (ADR-0016 §4): reset live-turn state → refetch
	// history → apply the opening snapshot (the server replays it via the
	// stream's own subscribe-time events, handled below). Runs on the first
	// connect, every native EventSource retry, and every reconnect forced by
	// the client's own staleness check — and also on an explicit `resync`
	// directive mid-turn (refusal-fallback retraction).
	const resync = useCallback(() => {
		setLive({});
		setTurnActivity(null);
		setThinkingBuffers({});
		sawTurnRef.current = false;
		loadHistory();
	}, [loadHistory]);

	// Keyed on sessionId only — deliberately NOT session.status: re-running
	// this effect mid-turn (as a status flip used to) wipes the live entries
	// and re-fetches history while the turn's rows are still provisional,
	// which is how messages briefly rendered out of order.
	useEffect(() => {
		setMessages([]);
		setError(null);
		setNotice(null);
		setThinking(false);
		setDegraded(false);
		let degradedTimer: ReturnType<typeof setTimeout> | null = null;
		const unsubscribe = api.sessions.stream(
			sessionId,
			(ev) => {
				switch (ev.type) {
					case "session_status":
						setStatus(ev.status);
						if (ev.status === "working" || ev.status === "starting") {
							sawTurnRef.current = true;
							// Covers the mid-turn (re)connect: the server replays a
							// working status on subscribe, and until the snapshot or the
							// next token arrives the thinking marker is the only signal
							// the agent is alive. The local send path sets this too.
							setThinking(true);
						}
						if (ev.status === "idle" || ev.status === "crashed") {
							setThinking(false);
							// turn_activity/thinking are valid only inside a turn
							// (ADR-0016 §5) — clear the client's own copy at any terminal
							// rather than waiting for an explicit clearing event.
							setTurnActivity(null);
							setThinkingBuffers({});
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
										// Explicitly ungroupable: a live entry is already one
										// whole turn's worth of parts (see `rendered`), and
										// this is a stopgap for the `loadHistory()` right
										// below, which replaces it with the DB row carrying
										// the real `turnId`.
										turnId: null,
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
					case "user_message":
						// Broadcast at accept time (ADR-0016 §6) — every subscriber
						// converges on this id. The sender's own tab may already have
						// swapped its optimistic tempId bubble for this same id via
						// handleSend's response (a benign race either way settles on
						// the same entry); non-sender tabs see this as the only signal
						// the turn started until the next content event.
						sawTurnRef.current = true;
						setLive((prev) => {
							if (prev[ev.message.id]) return prev;
							return {
								...prev,
								[ev.message.id]: {
									id: ev.message.id,
									role: "user",
									parts: ev.message.parts,
									startedAt: ev.message.createdAt,
								},
							};
						});
						break;
					case "message_start":
						// Always a new assistant turn message (pi.ts never emits
						// user-role starts); the optimistic temp user entry stays in
						// place until the idle-time reconcile swaps in the DB rows.
						sawTurnRef.current = true;
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
					case "tool_call_start":
					case "tool_call_end":
						// Content stops the 'Thinking...' marker — except tool_call_end,
						// which resolves a call whose _start already cleared it and can
						// arrive while the next round is thinking again.
						if (ev.type !== "tool_call_end") {
							setThinking(false);
							sawTurnRef.current = true;
						}
						setLive((prev) => applyEventToLive(prev, ev));
						break;
					case "message_end":
						// Discard this message's thinking buffer — it never persists
						// (ADR-0016 §5's invariant: `token` is exactly what persists,
						// `thinking` is exactly what doesn't).
						setThinkingBuffers((prev) => {
							if (!(ev.messageId in prev)) return prev;
							const next = { ...prev };
							delete next[ev.messageId];
							return next;
						});
						break;
					case "turn_failed":
						// The one failure event (ADR-0016 §2, replacing `error` +
						// `agent_crashed`): the terminal status itself (idle/crashed)
						// arrives as a separate session_status right after, handled
						// above.
						setThinking(false);
						setError(ev.message);
						break;
					case "notice":
						setNotice(ev.message);
						break;
					case "thinking":
						setThinkingBuffers((prev) => ({
							...prev,
							[ev.messageId]: (prev[ev.messageId] ?? "") + ev.chunk,
						}));
						break;
					case "turn_activity":
						setTurnActivity(ev);
						break;
					case "resync":
						resync();
						break;
				}
			},
			resync,
			(connected) => {
				if (connected) {
					if (degradedTimer) {
						clearTimeout(degradedTimer);
						degradedTimer = null;
					}
					setDegraded(false);
				} else if (!degradedTimer) {
					degradedTimer = setTimeout(() => {
						setDegraded(true);
						degradedTimer = null;
					}, 3000);
				}
			},
		);
		return () => {
			if (degradedTimer) clearTimeout(degradedTimer);
			unsubscribe();
		};
	}, [sessionId, resync, loadHistory]);

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
		// Attachments alone are a valid message ("look at this"), but only once
		// their upload has landed — an in-flight one has no id to reference yet.
		// An errored entry is simply left behind (see the Send button's own
		// comment): it must not block the send, or one bad file wedges the
		// composer.
		if ((!text && readyToSend.length === 0) || sending || working) return;
		if (pending.some((p) => p.status === "uploading")) return;
		setError(null);
		setSending(true);
		setThinking(true);

		const attached = readyToSend;
		// Optimistic user message placeholder — visible immediately so autoscroll
		// follows it; replaced by the authoritative DB row at the idle reconcile.
		// Mirrors the server's own part order (attachments first, then text) so
		// the bubble doesn't reshuffle when the real row arrives.
		const tempId = `temp-${Date.now()}`;
		setLive((prev) => ({
			...prev,
			[tempId]: {
				id: tempId,
				role: "user",
				parts: [
					...attached.map(
						(attachment): MessagePart => ({ type: "attachment", attachment }),
					),
					...(text ? [{ type: "text" as const, text }] : []),
				],
				startedAt: nowSeconds(),
			},
		}));

		try {
			const { message } = await api.sessions.send(
				sessionId,
				text,
				attached.map((a) => a.id),
			);
			// Only clear the composer once the send is actually accepted — the
			// tray included, so a rejected send keeps the files too, not just the
			// text.
			setInput("");
			clearPending();
			// Swap the optimistic tempId bubble for the persisted row's real id
			// (ADR-0016 §6) — the same row every other subscriber sees via the
			// `user_message` broadcast, so all clients converge on one id.
			setLive((prev) => {
				if (!(tempId in prev)) return prev;
				const next = { ...prev };
				delete next[tempId];
				next[message.id] = {
					id: message.id,
					role: "user",
					parts: message.parts,
					startedAt: message.createdAt,
				};
				return next;
			});
		} catch (e) {
			setThinking(false);
			// The message never reached the server — withdraw the optimistic
			// entry instead of leaving a bubble the agent never saw.
			setLive((prev) => {
				if (!(tempId in prev)) return prev;
				const next = { ...prev };
				delete next[tempId];
				return next;
			});
			if (e instanceof ApiError && e.status === 409) {
				// Lost the race to a concurrent send from another tab (ADR-0016
				// §6): keep the draft (the composer was never cleared above) and
				// show a quiet notice, not a destructive error — this tab is
				// already rendering the in-flight turn it lost to, via the same
				// stream every subscriber shares.
				setNotice(
					"Another tab just sent a message — your draft is still here.",
				);
			} else {
				setError(e instanceof Error ? e.message : "send failed");
			}
		} finally {
			setSending(false);
		}
	}, [input, sending, working, sessionId, pending, readyToSend, clearPending]);

	const handleStop = useCallback(async () => {
		try {
			await api.sessions.stop(sessionId);
		} catch (e) {
			setError(e instanceof Error ? e.message : "stop failed");
		}
	}, [sessionId]);

	const rendered = useMemo(
		() => mergeRenderedMessages(messages, live, sessionId),
		[messages, live, sessionId],
	);

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
										{rendered.map((m, i) =>
											m.role === "system" ? (
												<MessageScrollerItem key={m.id} messageId={m.id}>
													<Marker className="text-muted-foreground">
														<MarkerIcon>
															<Info className="size-4" />
														</MarkerIcon>
														<MarkerContent className="text-xs">
															{m.parts
																.filter((p) => p.type === "text")
																.map((p) => p.text)
																.join(" ")}
														</MarkerContent>
													</Marker>
												</MessageScrollerItem>
											) : (
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
														modelName={session.model}
														isStreaming={m.id in live}
														thinkingChunk={thinkingBuffers[m.id]}
														turnActivity={turnActivity}
													/>
												</MessageScrollerItem>
											),
										)}
										{thinking && <ThinkingMarker word={thinkingWord} />}
										{notice && (
											<MessageScrollerItem messageId="__notice">
												<Marker className="text-muted-foreground">
													<MarkerIcon>
														<Info className="size-4" />
													</MarkerIcon>
													<MarkerContent className="text-xs">
														{notice}
													</MarkerContent>
												</Marker>
											</MessageScrollerItem>
										)}
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

			<div className="px-6 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
				{degraded && (
					<p className="mx-auto mb-1.5 max-w-[max(48rem,80%)] text-center text-xs text-muted-foreground">
						Reconnecting…
					</p>
				)}
				{turnActivity?.phase && (
					<p className="mx-auto mb-1.5 max-w-[max(48rem,80%)] text-center text-xs text-muted-foreground">
						{PHASE_LABEL[turnActivity.phase.kind] ?? "Working…"}
						{turnActivity.phase.kind === "retrying" &&
							turnActivity.phase.attempt != null &&
							turnActivity.phase.maxRetries != null &&
							` (${turnActivity.phase.attempt}/${turnActivity.phase.maxRetries})`}
					</p>
				)}
				{/* Two stacked rows (the ChatGPT composer shape): the text area on
				    top spanning the full width, controls beneath it — attach on the
				    left, send/stop on the right. Putting the buttons on their own
				    row rather than beside the text is what leaves room for more
				    controls later without squeezing the input. */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: drag-and-drop is an addition to the keyboard-accessible Plus button and file input below, not a replacement for them. */}
				<div
					onDragEnter={(e) => {
						if (!e.dataTransfer.types.includes("Files")) return;
						e.preventDefault();
						setDragDepth((d) => d + 1);
					}}
					onDragOver={(e) => {
						// Required for `drop` to fire at all; without it the browser
						// navigates to the dropped file instead.
						if (e.dataTransfer.types.includes("Files")) e.preventDefault();
					}}
					onDragLeave={() => setDragDepth((d) => Math.max(0, d - 1))}
					onDrop={handleDrop}
					className={cn(
						"mx-auto flex max-w-[max(48rem,80%)] flex-col gap-1 rounded-xl border bg-card px-3 py-2 shadow-sm transition-colors focus-within:border-ring/60",
						dragDepth > 0
							? "border-primary border-dashed bg-accent/40"
							: "border-border",
					)}
				>
					{pending.length > 0 && (
						<div className="flex flex-wrap gap-2 px-1 pt-1 pb-0.5">
							{pending.map((item) => (
								<PendingAttachmentCard
									key={item.localId}
									item={item}
									onRemove={() => removePending(item.localId)}
								/>
							))}
						</div>
					)}
					<textarea
						ref={textareaRef}
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onPaste={handlePaste}
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
								: `Message ${assistantDisplayName(session.model, session.agentType)}…`
						}
						rows={2}
						className="w-full resize-none bg-transparent px-1 py-1.5 text-base outline-none"
					/>
					<div className="flex items-center gap-2">
						<input
							ref={fileInputRef}
							type="file"
							multiple
							className="hidden"
							onChange={(e) => {
								// Snapshot the FileList before clearing the input below:
								// `addFiles` is async, and resetting `value` empties
								// `e.target.files` synchronously — so passing the live list
								// would hand it an already-emptied collection.
								const picked = Array.from(e.target.files ?? []);
								// Clear the input so re-picking the same file fires `change`
								// again — without this, removing a file from the tray and
								// re-selecting it silently does nothing.
								e.target.value = "";
								void addFiles(picked);
							}}
						/>
						<button
							type="button"
							onClick={() => fileInputRef.current?.click()}
							disabled={pending.length >= MAX_ATTACHMENTS}
							className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border transition-colors hover:bg-accent active:scale-[0.97] disabled:opacity-40"
							title="Attach files"
							aria-label="Attach files"
						>
							<Plus className="size-4" />
						</button>
						<div className="flex-1" />
						{working ? (
							<button
								type="button"
								onClick={handleStop}
								className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border transition-colors hover:bg-accent active:scale-[0.97]"
								title="Stop"
							>
								<Square className="size-3.5" />
							</button>
						) : (
							<button
								type="button"
								onClick={handleSend}
								// An attachment-only message is still a message worth
								// sending ("look at this"), but not while an upload is
								// still in flight — its id doesn't exist yet.
								//
								// Only `"uploading"` blocks, never `"error"`: a failed
								// upload deliberately stays in the tray (so the user sees
								// which file didn't make it), and treating that as "not
								// ready" would wedge the composer — a typed draft could
								// not be sent until the user spotted the small ✕. The
								// send simply leaves errored entries behind.
								disabled={
									(!input.trim() && readyToSend.length === 0) ||
									sending ||
									pending.some((p) => p.status === "uploading")
								}
								className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-[background-color,scale] hover:bg-primary/90 active:scale-[0.97] disabled:opacity-40"
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

/**
 * One entry in the composer's file tray: an image shows its local preview
 * (no server round trip needed — the blob is right there), anything else a
 * name-and-icon card. Both carry a remove button, and an upload that failed
 * stays visible in a destructive style rather than vanishing, so the user
 * sees which file didn't make it.
 */
function PendingAttachmentCard({
	item,
	onRemove,
}: {
	item: PendingAttachment;
	onRemove: () => void;
}) {
	const failed = item.status === "error";
	return (
		<div
			className={cn(
				"group/pending relative flex items-center gap-2 rounded-lg border bg-background py-1.5 pr-7 pl-2",
				failed ? "border-destructive/50" : "border-border",
			)}
			title={failed ? item.error : item.filename}
		>
			{item.previewUrl ? (
				<img
					src={item.previewUrl}
					alt=""
					className="size-8 shrink-0 rounded object-cover"
				/>
			) : (
				<FileText className="size-4 shrink-0 text-muted-foreground" />
			)}
			<span className="min-w-0 max-w-36">
				<span className="block truncate text-xs font-medium">
					{item.filename}
				</span>
				<span
					className={cn(
						"block text-[0.6875rem]",
						failed ? "text-destructive" : "text-muted-foreground",
					)}
				>
					{failed
						? (item.error ?? "upload failed")
						: item.status === "uploading"
							? "Uploading…"
							: formatAttachmentSize(item.size)}
				</span>
			</span>
			{item.status === "uploading" && (
				<LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
			)}
			<button
				type="button"
				onClick={onRemove}
				className="absolute top-1 right-1 flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				title="Remove"
				aria-label={`Remove ${item.filename}`}
			>
				<X className="size-3" />
			</button>
		</div>
	);
}

/**
 * One attachment inside a sent message. Images render as the picture itself
 * (that's the whole point of having sent one); every other kind gets a card
 * with its name, icon and size — a rich preview for documents is a separate
 * task, and a card is the honest placeholder until then.
 *
 * Both are links to the raw bytes, so clicking an image opens it full size
 * and clicking a document downloads it.
 */
function SentAttachment({ attachment }: { attachment: Attachment }) {
	const href = attachmentUrl(attachment.sessionId, attachment.id);
	if (attachment.kind === "image") {
		return (
			<a
				href={href}
				target="_blank"
				rel="noreferrer"
				className="block overflow-hidden rounded-lg border border-border"
			>
				<img
					src={href}
					alt={attachment.filename}
					// Bounded rather than full-width: a screenshot shouldn't push the
					// conversation off the screen, and the link opens the original.
					className="max-h-80 max-w-full object-contain"
				/>
			</a>
		);
	}
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className="flex max-w-72 items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2 transition-colors hover:bg-accent"
		>
			<FileText className="size-4 shrink-0 text-muted-foreground" />
			<span className="min-w-0">
				<span className="block truncate text-sm font-medium">
					{attachment.filename}
				</span>
				<span className="block text-xs text-muted-foreground">
					{formatAttachmentSize(attachment.size)}
				</span>
			</span>
		</a>
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
	modelName,
	isStreaming,
	thinkingChunk,
	turnActivity,
}: {
	id: string;
	role: "user" | "assistant";
	parts: MessagePart[];
	createdAt: number;
	showAttribution: boolean;
	agentType: AgentType;
	modelName?: string | null;
	isStreaming?: boolean;
	thinkingChunk?: string;
	turnActivity?: TurnActivity | null;
}) {
	const name =
		role === "user" ? "You" : assistantDisplayName(modelName, agentType);

	// Group consecutive tool call parts into collapsible sections.
	const rows: React.ReactNode[] = [];
	let toolBuffer: Extract<MessagePart, { type: "tool_call" }>[] = [];
	function flushTools() {
		if (toolBuffer.length > 0) {
			rows.push(
				<ToolCallGroup
					key={`g-${rows.length}`}
					parts={toolBuffer}
					turnActivity={turnActivity}
				/>,
			);
			toolBuffer = [];
		}
	}
	// Attachments render above the message's text as one row of cards/images,
	// regardless of where they sit among the parts — matching how the composer
	// stacks its file tray over the input, so a sent message looks like what
	// was composed.
	const attached = parts.filter((p) => p.type === "attachment");

	parts.forEach((p, i) => {
		if (p.type === "attachment") return;
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

	// Copying serializes the stored markdown source rather than the DOM, so
	// list markers and code fences survive the trip (see partsToMarkdown).
	// Hidden until hover/focus so it doesn't compete with the attribution row.
	const copyText = rows.length > 0 && (
		<CopyButton
			getText={() => partsToMarkdown(parts)}
			label="Copy message"
			className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover/message:opacity-100"
		/>
	);

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
						{copyText}
					</MessageHeader>
				) : (
					<MessageHeader className="gap-1.5 px-0 invisible text-xs tabular-nums group-hover/message:visible">
						<span>{formatClockTime(createdAt)}</span>
						{copyText}
					</MessageHeader>
				)}
				{isStreaming && role === "assistant" && (
					<ThinkingBlock
						chunk={thinkingChunk}
						tokens={turnActivity?.thinkingTokens}
					/>
				)}
				{attached.length > 0 && (
					<div className="flex flex-wrap gap-2">
						{attached.map((p) => (
							<SentAttachment key={p.attachment.id} attachment={p.attachment} />
						))}
					</div>
				)}
				{rows.length > 0 ? (
					rows
				) : attached.length > 0 ? null : (
					<span className="text-xs text-muted-foreground">{id}</span>
				)}
			</MessageContent>
		</Message>
	);
}

/** Streaming-only, expandable header+preview for `thinking` chunks
 * (ADR-0016 §5) — degrades to the redacted-phase token counter when no
 * chunks have arrived, and vanishes entirely (the caller stops rendering
 * this) once neither is present. */
function ThinkingBlock({
	chunk,
	tokens,
}: {
	chunk: string | undefined;
	tokens: number | undefined;
}) {
	const [expanded, setExpanded] = useState(false);
	if (!chunk && !tokens) return null;
	return (
		<div className="mb-1.5 rounded-lg border border-border/60 bg-muted/20 px-2.5 py-1.5 text-xs text-muted-foreground">
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				disabled={!chunk}
				className="flex w-full items-center gap-1 rounded font-medium transition-colors hover:text-foreground active:text-foreground/80"
			>
				{chunk &&
					(expanded ? (
						<ChevronDown className="size-3" />
					) : (
						<ChevronRight className="size-3" />
					))}
				Thinking{chunk ? "" : tokens ? ` (~${tokens} tokens)` : ""}
			</button>
			{expanded && chunk && (
				<pre className="mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap font-sans">
					{chunk}
				</pre>
			)}
		</div>
	);
}

function ToolCallGroup({
	parts,
	turnActivity,
}: {
	parts: Extract<MessagePart, { type: "tool_call" }>[];
	turnActivity?: TurnActivity | null;
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
					className="flex w-full cursor-pointer items-center gap-1 rounded text-xs font-medium text-muted-foreground transition-colors hover:text-foreground active:text-foreground/80"
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
							<ToolCallMarker
								key={p.callId}
								part={p}
								turnActivity={turnActivity}
							/>
						))}
					</div>
				)}
			</MarkerContent>
		</Marker>
	);
}

function ToolCallMarker({
	part,
	turnActivity,
}: {
	part: Extract<MessagePart, { type: "tool_call" }>;
	turnActivity?: TurnActivity | null;
}) {
	const [open, setOpen] = useState(false);
	const running = part.output == null && part.error == null;
	const failed = part.error != null;
	const meta = getToolMeta(part.tool, part.input);
	const Icon = meta.icon;

	// Elapsed badge (ADR-0016 §5): ticks off `runningTools`' startedAt, skew
	// corrected against `serverTime`. Re-render every second only while this
	// tool call is actually the one running.
	const runningToolInfo = turnActivity?.runningTools.find(
		(t) => t.callId === part.callId,
	);
	const [, forceTick] = useState(0);
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on whether a running tool matched at all, not the object itself — turnActivity is replaced wholesale on every broadcast, and re-arming the interval on each one would just jitter the tick offset for no benefit.
	useEffect(() => {
		if (!runningToolInfo) return;
		const t = setInterval(() => forceTick((n) => n + 1), 1000);
		return () => clearInterval(t);
	}, [Boolean(runningToolInfo)]);
	const elapsed =
		runningToolInfo && turnActivity
			? elapsedSeconds(runningToolInfo.startedAt, turnActivity.serverTime)
			: null;

	// Task activity line (ADR-0016 §5): anchored under the Task tool_call that
	// spawned it, matched by the spawning call's id.
	const task = turnActivity?.tasks.find((t) => t.toolUseId === part.callId);
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
					"flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors",
					hasDetails && "cursor-pointer hover:bg-accent/30 active:bg-accent/50",
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
				<span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
					{elapsed != null && <span className="tabular-nums">{elapsed}s</span>}
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
			{task && (
				<div className="flex items-center gap-1.5 border-t border-border px-2.5 py-1 text-xs text-muted-foreground">
					<ListTree className="size-3 shrink-0" />
					<span className="truncate">
						{task.description} — {task.toolUses} tool call
						{task.toolUses === 1 ? "" : "s"}
						{task.lastTool ? ` (${task.lastTool})` : ""}
					</span>
				</div>
			)}
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
