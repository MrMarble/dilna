import {
	type AgentType,
	type Attachment,
	formatAttachmentSize,
	type MessagePart,
	type QueuedMessage,
	type SessionView,
} from "@dilna/shared";
import {
	AlertCircle,
	ChevronDown,
	ChevronRight,
	Clock,
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
import {
	useCallback,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import { ApiError, api, attachmentUrl } from "@/api/client";
import { SlashCommandMenu } from "@/components/SlashCommandMenu";
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
import { useRepoSkills } from "@/hooks/useRepoSkills";
import { useSessionDraft } from "@/hooks/useSessionDraft";
import { AgentIcon } from "@/lib/agent-icons";
import { assistantDisplayName } from "@/lib/agent-labels";
import {
	chatReducer,
	initialChatState,
	type TurnActivity,
} from "@/lib/chat-reducer";
import { mergeRenderedMessages, nowSeconds } from "@/lib/live-messages";
import { partsToMarkdown } from "@/lib/message-markdown";
import {
	applySlashCommand,
	matchSkills,
	slashQuery,
} from "@/lib/slash-commands";
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
	// The whole stream fold — messages, live overlay, status, queue, thinking,
	// turn activity and the flags around them — held as one value and reduced
	// through `chatReducer` (issue #237). Every transition that used to be a
	// `setState` from inside the stream effect is now a dispatched action, so
	// the fold is testable without mounting this component.
	const [state, dispatch] = useReducer(
		(s, action) => chatReducer(s, action),
		initialChatState(sessionId, session.status),
	);
	const {
		messages,
		live,
		status,
		queued,
		thinking,
		turnActivity,
		thinkingBuffers,
		error,
		notice,
		degraded,
	} = state;
	/** Composer text, persisted per Session so navigating away (another
	 * Session, Settings, a reload) doesn't lose a half-written message. */
	const {
		value: input,
		setValue: setInput,
		clear: clearDraft,
	} = useSessionDraft(sessionId);
	/** Purely local in-flight flag for the composer's send/stop buttons — the
	 * stream never touches it, so it stays out of the reducer. */
	const [sending, setSending] = useState(false);

	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const { pending, addFiles, removePending, clearPending } =
		usePendingAttachments(sessionId);

	// Slash-command autocomplete over this Repo's enabled Skills. `dismissed`
	// is what Escape sets: the query can still be a valid `/ver`, so without it
	// the menu would reopen on the very next keystroke.
	const repoSkills = useRepoSkills(session.repoId);
	const [slashDismissed, setSlashDismissed] = useState(false);
	const [slashIndex, setSlashIndex] = useState(0);
	const slashMatches = useMemo(() => {
		if (slashDismissed) return [];
		const query = slashQuery(input);
		if (query === null) return [];
		return matchSkills(repoSkills, query);
	}, [input, repoSkills, slashDismissed]);
	const slashOpen = slashMatches.length > 0;

	// Re-filtering can shorten the list under a highlight that was further
	// down; clamp rather than reset so typing doesn't keep yanking the
	// selection back to the top row.
	const clampedSlashIndex = Math.min(slashIndex, slashMatches.length - 1);

	const acceptSlashCommand = useCallback(
		(name: string) => {
			setInput(applySlashCommand(name));
			setSlashIndex(0);
			textareaRef.current?.focus();
		},
		[setInput],
	);

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
			dispatch({ type: "history_loaded", messages });
		} catch (e) {
			dispatch({
				type: "error_set",
				message: e instanceof Error ? e.message : "failed to load messages",
			});
		}
	}, [sessionId]);

	// The one on-open routine (ADR-0016 §4): reset live-turn state → refetch
	// history → apply the opening snapshot (the server replays it via the
	// stream's own subscribe-time events, handled below). Runs on the first
	// connect, every native EventSource retry, and every reconnect forced by
	// the client's own staleness check — and also on an explicit `resync`
	// directive mid-turn (refusal-fallback retraction).
	const loadQueue = useCallback(async () => {
		try {
			const { queued } = await api.sessions.queuedMessages(sessionId);
			dispatch({ type: "queue_loaded", queued });
		} catch {
			// Non-fatal — the tray just stays as-is until the next `queue_update`
			// event or resync converges it; history loading already surfaces
			// connectivity errors.
		}
	}, [sessionId]);

	const resync = useCallback(() => {
		dispatch({ type: "reset" });
		loadHistory();
		// The queue's REST snapshot (ADR-0033), alongside history's — the
		// `queue_update` stream keeps it live from here.
		loadQueue();
	}, [loadHistory, loadQueue]);

	// The stream fold's imperative counterpart: this effect owns the transport
	// subscription and the connections' timers, and every event it receives is
	// handed to `chatReducer` as an action. Nothing here sets chat state
	// directly any more (issue #237) — the transitions live in the reducer,
	// where they can be asserted on without jsdom.
	//
	// Keyed on sessionId only — deliberately NOT session.status: re-running
	// this effect mid-turn (as a status flip used to) wipes the live entries
	// and re-fetches history while the turn's rows are still provisional,
	// which is how messages briefly rendered out of order.
	useEffect(() => {
		dispatch({ type: "session_changed", sessionId });
		let degradedTimer: ReturnType<typeof setTimeout> | null = null;
		const unsubscribe = api.sessions.stream(
			sessionId,
			(ev) => dispatch(ev),
			resync,
			(connected) => {
				if (connected) {
					if (degradedTimer) {
						clearTimeout(degradedTimer);
						degradedTimer = null;
					}
					dispatch({ type: "degraded", value: false });
				} else if (!degradedTimer) {
					degradedTimer = setTimeout(() => {
						dispatch({ type: "degraded", value: true });
						degradedTimer = null;
					}, 3000);
				}
			},
		);
		return () => {
			if (degradedTimer) clearTimeout(degradedTimer);
			unsubscribe();
		};
	}, [sessionId, resync]);

	// The reconcile the reducer asks for (see `ChatState.reconcile`): a terminal
	// status that ended a turn this tab saw bumps the counter, and this effect
	// turns that into the one history refetch. Keyed on the counter, never on
	// `messages` — the fetch writes state, so keying on state would loop.
	const handledReconcile = useRef(0);
	useEffect(() => {
		if (state.reconcile === handledReconcile.current) return;
		handledReconcile.current = state.reconcile;
		loadHistory();
	}, [state.reconcile, loadHistory]);

	useEffect(() => {
		dispatch({ type: "status_synced", status: session.status });
	}, [session.status]);

	const working = status === "working" || status === "starting";
	// Broader than `working`: any status under which the server would 409 a
	// send (ADR-0016 §2) — "stopping" included, which `working` deliberately
	// excludes for the Stop button's sake. This is what routes a submit into
	// the queue instead of a doomed POST.
	const busy = working || status === "stopping";

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
		if ((!text && readyToSend.length === 0) || sending) return;
		if (pending.some((p) => p.status === "uploading")) return;

		const attached = readyToSend;
		// Queue instead of send whenever a direct POST couldn't be accepted
		// right now (busy → the server would 409) or would jump the line
		// (entries already queued — ordering is the queue's contract). The
		// server holds the queue and dispatches at the next turn boundary
		// (ADR-0033), so this tab — or any tab, or no tab — being open later
		// doesn't matter. An enqueue that races the turn's end is fine: the
		// server dispatches immediately when it finds the Session idle.
		if (busy || queued.length > 0) {
			dispatch({ type: "error_set", message: null });
			setSending(true);
			try {
				const { entry } = await api.sessions.queueMessage(
					sessionId,
					text,
					attached.map((a) => a.id),
				);
				// Composer clears only on acceptance, mirroring the send path —
				// the message now lives in the visible queue tray. `clearDraft`
				// (not `setInput("")`) so the persisted draft goes immediately,
				// with no debounce window for a reload to resurrect it.
				clearDraft();
				clearPending();
				// Optimistic append; the `queue_update` broadcast carries the same
				// entry id, and level-based replacement makes the merge idempotent
				// whichever lands first.
				dispatch({ type: "queued_added", entry });
			} catch (e) {
				// Draft preserved (composer untouched above) — same contract as a
				// rejected direct send.
				dispatch({
					type: "error_set",
					message: e instanceof Error ? e.message : "failed to queue message",
				});
			} finally {
				setSending(false);
			}
			return;
		}
		// Optimistic user message placeholder — visible immediately so autoscroll
		// follows it; replaced by the authoritative DB row at the idle reconcile.
		// Mirrors the server's own part order (attachments first, then text) so
		// the bubble doesn't reshuffle when the real row arrives.
		const tempId = `temp-${Date.now()}`;
		setSending(true);
		dispatch({
			type: "send_started",
			message: {
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
		});

		try {
			const { message } = await api.sessions.send(
				sessionId,
				text,
				attached.map((a) => a.id),
			);
			// Only clear the composer once the send is actually accepted — the
			// tray included, so a rejected send keeps the files too, not just the
			// text. `clearDraft` (not `setInput("")`) so the persisted draft goes
			// immediately, with no debounce window for a reload to resurrect it.
			clearDraft();
			clearPending();
			// Swap the optimistic tempId bubble for the persisted row's real id
			// (ADR-0016 §6) — the same row every other subscriber sees via the
			// `user_message` broadcast, so all clients converge on one id.
			dispatch({ type: "send_accepted", tempId, message });
		} catch (e) {
			// The message never reached the server — withdraw the optimistic
			// entry instead of leaving a bubble the agent never saw.
			if (e instanceof ApiError && e.status === 409) {
				// Lost the race to a concurrent send from another tab (ADR-0016
				// §6): keep the draft (the composer was never cleared above) and
				// show a quiet notice, not a destructive error — this tab is
				// already rendering the in-flight turn it lost to, via the same
				// stream every subscriber shares.
				dispatch({ type: "send_conflict", tempId });
			} else {
				dispatch({
					type: "send_failed",
					tempId,
					message: e instanceof Error ? e.message : "send failed",
				});
			}
		} finally {
			setSending(false);
		}
	}, [
		input,
		sending,
		busy,
		queued.length,
		sessionId,
		pending,
		readyToSend,
		clearDraft,
		clearPending,
	]);

	/** Withdraw a queued entry (ADR-0033). Optimistic removal after the
	 * server confirms; idempotent server-side, so racing the dispatch is
	 * harmless — either way the entry is no longer queued, and the
	 * `queue_update` broadcast converges every tab. */
	const handleRemoveQueued = useCallback(
		async (queuedId: string) => {
			try {
				await api.sessions.removeQueuedMessage(sessionId, queuedId);
				dispatch({ type: "queued_removed", queuedId });
			} catch (e) {
				dispatch({
					type: "error_set",
					message: e instanceof Error ? e.message : "failed to remove message",
				});
			}
		},
		[sessionId],
	);

	const handleStop = useCallback(async () => {
		try {
			await api.sessions.stop(sessionId);
		} catch (e) {
			dispatch({
				type: "error_set",
				message: e instanceof Error ? e.message : "stop failed",
			});
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
							<MessageScrollerContent className="mx-auto w-full max-w-[max(48rem,80%)] px-4 pt-5 pb-8 sm:px-6">
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
														provider={session.provider}
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

			<div className="px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6">
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
				{/* Running subagents (issue #206, ADR-0034). A bare count, not a
				    per-task breakdown: the point is that the user knows work is
				    fanned out, and the turn's own tool-call rows already carry the
				    detail. `turn_activity.tasks` does carry description/lastTool,
				    so a richer view is a client-only change later. */}
				{turnActivity && turnActivity.tasks.length > 0 && (
					<p className="mx-auto mb-1.5 max-w-[max(48rem,80%)] text-center text-xs text-muted-foreground">
						{turnActivity.tasks.length === 1
							? "1 active task"
							: `${turnActivity.tasks.length} active tasks`}
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
						// `relative` anchors the slash-command menu, which sits
						// absolutely above this box.
						"relative mx-auto flex max-w-[max(48rem,80%)] flex-col gap-1 rounded-xl border bg-card px-3 py-2 shadow-sm transition-colors focus-within:border-ring/60",
						dragDepth > 0
							? "border-primary border-dashed bg-accent/40"
							: "border-border",
					)}
				>
					{queued.length > 0 && (
						<div className="flex flex-col gap-1 px-1 pt-1 pb-0.5">
							{queued.map((entry) => (
								<QueuedMessageRow
									key={entry.id}
									entry={entry}
									onRemove={() => void handleRemoveQueued(entry.id)}
								/>
							))}
						</div>
					)}
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
					{slashOpen && (
						<SlashCommandMenu
							commands={slashMatches}
							activeIndex={clampedSlashIndex}
							onHighlight={setSlashIndex}
							onSelect={acceptSlashCommand}
						/>
					)}
					<textarea
						ref={textareaRef}
						value={input}
						onChange={(e) => {
							setInput(e.target.value);
							// Escape's dismissal lasts only as long as the command token
							// it dismissed; clearing the box or starting a new `/` re-arms.
							if (slashQuery(e.target.value) === null) setSlashDismissed(false);
						}}
						onPaste={handlePaste}
						onKeyDown={(e) => {
							// While the slash menu is open it owns the navigation keys —
							// including Enter, which accepts the highlighted Skill instead
							// of sending a half-typed command.
							if (slashOpen) {
								if (e.key === "ArrowDown" || e.key === "ArrowUp") {
									e.preventDefault();
									const step = e.key === "ArrowDown" ? 1 : -1;
									const next =
										(clampedSlashIndex + step + slashMatches.length) %
										slashMatches.length;
									setSlashIndex(next);
									return;
								}
								if (e.key === "Enter" || e.key === "Tab") {
									e.preventDefault();
									const picked = slashMatches[clampedSlashIndex];
									if (picked) acceptSlashCommand(picked.name);
									return;
								}
								if (e.key === "Escape") {
									e.preventDefault();
									setSlashDismissed(true);
									return;
								}
							}
							// On desktop, Enter sends and Shift+Enter inserts a newline.
							// Mobile keyboards don't reliably expose Shift, so there
							// Enter just inserts a newline and the Send button submits.
							if (isDesktop && e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								void handleSend();
							}
						}}
						placeholder={
							working
								? `${thinkingWord}… type to queue your next message`
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
						{working && (
							<button
								type="button"
								onClick={handleStop}
								className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border transition-colors hover:bg-accent active:scale-[0.97]"
								title="Stop"
								aria-label="Stop"
							>
								<Square className="size-3.5" />
							</button>
						)}
						{/* Rendered alongside Stop while working (it queues then), not
						    instead of it — mobile has no Enter-to-send, so without a
						    visible button there'd be no way to queue at all. */}
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
							// Send vs Queue names the *action*, like a submit button that reads
							// "Create account" on a signup form — it is not a toggle, so the
							// label tracks what clicking will do. `aria-busy` carries the
							// in-flight state (issue #223).
							title={busy || queued.length > 0 ? "Queue message" : "Send"}
							aria-label={busy || queued.length > 0 ? "Queue message" : "Send"}
							aria-busy={sending}
						>
							{sending ? (
								<LoaderCircle className="size-3.5 animate-spin" />
							) : (
								<Send className="size-3.5" />
							)}
						</button>
					</div>
				</div>
				<p className="mx-auto mt-1.5 max-w-[max(48rem,80%)] text-center text-xs text-muted-foreground">
					{busy || queued.length > 0
						? isDesktop
							? "Enter to queue — sends when the agent is ready."
							: "Tap Send to queue — sends when the agent is ready."
						: isDesktop
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
 * One queued message in the composer's queue tray (ADR-0033): a compact
 * one-line preview of what will be sent, with a remove button — removal is
 * only possible here, before dispatch; once the server drains the queue
 * into a turn it's a normal message.
 */
function QueuedMessageRow({
	entry,
	onRemove,
}: {
	entry: QueuedMessage;
	onRemove: () => void;
}) {
	const label =
		entry.text.trim() ||
		(entry.attachments.length > 0
			? entry.attachments.map((a) => a.filename).join(", ")
			: "(empty message)");
	return (
		<div
			className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-2.5 py-1.5 text-xs"
			title={entry.text}
		>
			<Clock className="size-3.5 shrink-0 text-muted-foreground" />
			<span className="min-w-0 flex-1 truncate">{label}</span>
			{entry.attachments.length > 0 && (
				<span className="shrink-0 text-muted-foreground">
					{entry.attachments.length} file
					{entry.attachments.length > 1 ? "s" : ""}
				</span>
			)}
			<span className="shrink-0 text-muted-foreground">queued</span>
			<button
				type="button"
				onClick={onRemove}
				className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				title="Remove"
				aria-label="Remove queued message"
			>
				<X className="size-3" />
			</button>
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
	provider,
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
	/** `SessionView.provider` — picks the brand icon for the avatar; null/
	 * absent (pre-multi-provider Sessions) falls back to the Agent glyph. */
	provider?: string | null;
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
	// A *user* message's attachments render above its text as one row of
	// cards/images, regardless of where they sit among the parts — matching how
	// the composer stacks its file tray over the input, so a sent message looks
	// like what was composed.
	//
	// An *assistant* message's are left in place instead (issue #222,
	// ADR-0038): the Agent sends an image at a point in its reasoning — after
	// the prose that introduces it, before the prose that interprets it — and
	// hoisting would put every picture above the sentence that says what it
	// shows.
	const hoistAttachments = role === "user";
	const attached = hoistAttachments
		? parts.filter((p) => p.type === "attachment")
		: [];

	parts.forEach((p, i) => {
		if (p.type === "attachment") {
			if (hoistAttachments) return;
			flushTools();
			rows.push(
				<div key={`a-${p.attachment.id}`} className="flex flex-wrap gap-2">
					<SentAttachment attachment={p.attachment} />
				</div>,
			);
			return;
		}
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

	const avatar = showAttribution && (
		<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted">
			{role === "user" ? (
				<User className="size-4" />
			) : (
				<AgentIcon
					agentType={agentType}
					provider={provider}
					className="size-4"
				/>
			)}
		</span>
	);

	return (
		// The avatar gutter is a desktop-only affordance: on phones the column
		// would indent *every* line — including the continuation rows that have
		// no avatar at all — by ~44px of an already-narrow measure. Below `sm`
		// the gutter collapses and the avatar rides inline in the header row.
		<Message className="group/message gap-0 sm:gap-3">
			<div className="hidden w-8 shrink-0 justify-center self-start sm:flex">
				{avatar}
			</div>
			<MessageContent>
				{showAttribution ? (
					<MessageHeader className="items-center gap-2 px-0 sm:items-baseline">
						<span className="sm:hidden">{avatar}</span>
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
