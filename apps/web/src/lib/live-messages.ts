import {
	type AgentStreamEvent,
	applyEventToParts,
	type MessagePart,
} from "@dilna/shared";

/** One in-flight message being rendered from the live event stream, before
 * the turn ends and the authoritative DB rows replace it. */
export type LiveMessage = {
	id: string;
	role: "user" | "assistant";
	/** Text and tool_call parts in the order they actually streamed in, so
	 * live rendering matches the interleaving persisted after the turn. */
	parts: MessagePart[];
	/** Epoch seconds this message started streaming — used for the
	 * attribution timestamp before it's persisted with a real createdAt. */
	startedAt: number;
};

/** The content-carrying subset {@link applyEventToLive} handles — the same
 * events `@dilna/shared`'s `isMessageContentEvent` narrows to. */
export type MessageContentEvent = Extract<
	AgentStreamEvent,
	{ type: "token" | "tool_call_start" | "tool_call_end" }
>;

/**
 * Apply one content-carrying event to the keyed live-message map: resolve
 * *which* message it addresses, then merge its parts via `@dilna/shared`'s
 * {@link applyEventToParts} — the same fold the server runs to build the
 * snapshot it replays to a tab that connects mid-turn (see the server's
 * `sessions/liveTurn.ts`), so a reloaded tab and a tab that watched the turn
 * stream live converge on identical parts.
 *
 * Message resolution is the client's own, and deliberately not shared — the
 * server holds a single snapshot per turn where this keys a map:
 *
 * - a `tool_call_end` for an unknown message is dropped; there is no part for
 *   it to fill in, and inventing an entry would render a resolved tool call
 *   with no call ever having been shown;
 * - a `token`/`tool_call_start` for an unknown message *creates* the entry —
 *   a tab that connected mid-turn missed the `message_start`, and dropping
 *   these would leave a tool-heavy turn rendering nothing at all.
 *
 * Returns the same map reference when nothing changed, so React can bail out
 * of the state update.
 */
export function applyEventToLive(
	live: Record<string, LiveMessage>,
	ev: MessageContentEvent,
	/** Injectable for tests; defaults to the wall clock. */
	now: () => number = nowSeconds,
): Record<string, LiveMessage> {
	const existing = live[ev.messageId];
	if (!existing && ev.type === "tool_call_end") return live;
	const message: LiveMessage = existing ?? {
		id: ev.messageId,
		role: "assistant",
		parts: [],
		startedAt: now(),
	};
	const parts = applyEventToParts(message.parts, ev);
	if (existing && parts === existing.parts) return live;
	return { ...live, [ev.messageId]: { ...message, parts } };
}

export function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

/** One entry of `ChatShell`'s rendered list — either one persisted/live row,
 * or several of them folded back into the single message their turn was. */
export type RenderedMessage = {
	id: string;
	role: "user" | "assistant" | "system";
	parts: MessagePart[];
	createdAt: number;
};

/** The `Message`-shaped subset {@link foldTurnRows} reads. Structural so the
 * client can pass its own locally-built rows (which carry `turnId` from the
 * DB row but not the rest of `Message`) without a cast. */
export type TurnRow = {
	id: string;
	role: "user" | "assistant" | "system";
	parts: MessagePart[];
	createdAt: number;
	turnId?: string | null;
};

/**
 * Collapse consecutive rows sharing a non-null `turnId` back into one message,
 * restoring the shape the live view already renders.
 *
 * ADR-0026 §3 persists an assistant response as one row per pi-agent-core
 * *round*, so a turn that calls tools across several rounds lands as several
 * consecutive rows. Live, the client renders one message per turn (the
 * server normalizer pins one `messageId` per turn), so the persisted history
 * used to flip a grouped turn into N separate messages the moment it
 * reloaded. `turnId` is the signal that says which rows were one turn;
 * this is the fold that consumes it.
 *
 * Rows are folded in list order, and only when *adjacent*: a turn's rows are
 * always written contiguously (they're appended as the turn progresses, and
 * nothing else writes to the session mid-turn), so adjacency is guaranteed
 * in practice — and requiring it keeps the fold from ever pulling a row
 * across an intervening user message if that invariant is one day broken.
 *
 * `turnId` null/absent (user rows, `system` notices, pre-migration rows) is
 * never grouped and never matched against another null — each stays its own
 * message, so a legacy session renders exactly as it did before.
 *
 * The folded message keeps the first row's `id` and `createdAt` (the turn's
 * opening timestamp and a stable React key), and concatenates parts in row
 * order, which is stream order — so tool calls that spanned rounds sit
 * adjacently in one `parts` array and `ToolCallGroup` groups them again.
 */
export function foldTurnRows(rows: TurnRow[]): RenderedMessage[] {
	const out: RenderedMessage[] = [];
	let open: RenderedMessage | null = null;
	let openTurnId: string | null = null;

	for (const row of rows) {
		const turnId = row.turnId ?? null;
		if (turnId !== null && turnId === openTurnId && open) {
			open.parts = [...open.parts, ...row.parts];
			continue;
		}
		open = {
			id: row.id,
			role: row.role,
			parts: row.parts,
			createdAt: row.createdAt,
		};
		openTurnId = turnId;
		out.push(open);
	}

	return out;
}
