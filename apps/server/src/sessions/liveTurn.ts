import {
	type AgentStreamEvent,
	applyEventToParts,
	isMessageContentEvent,
	type MessagePart,
} from "@dilna/shared";

/**
 * The in-flight turn's assistant message accumulated so far, mirrored
 * server-side from the same events broadcast to subscribers. Kept in memory
 * on the ActiveAgent — never persisted; the DB stays the sole durable record
 * (ADR-0004/0014). Its purpose is the mid-turn subscribe gap: `message_start`
 * and earlier tool/token events are emitted once, so a subscriber that
 * connects mid-turn (page reload, second device) would otherwise render
 * nothing until the turn's next text token.
 *
 * The part-merging rules themselves live in `@dilna/shared`'s
 * {@link applyEventToParts} — ChatShell reconstructs the same message from
 * the same events and must agree with this on every rule.
 */
export type LiveTurn = { messageId: string; parts: MessagePart[] };

/** Fold one broadcast event into the session's live-turn snapshot. Owns only
 * *which* message is being accumulated — one per turn, so a `message_start`
 * opens a fresh snapshot and a content event for a turn whose start this
 * process never saw adopts that event's own messageId. The part-merging
 * itself is {@link applyEventToParts}'s. Events that carry no message content
 * (status, usage, diff, crash) pass the snapshot through untouched. */
export function applyEventToLiveTurn(
	turn: LiveTurn | null,
	ev: AgentStreamEvent,
): LiveTurn | null {
	if (ev.type === "message_start") {
		// One assistant messageId per turn (see NormalizeState in agents/pi.ts),
		// so a start simply opens a fresh snapshot. A user-role start isn't part
		// of the assistant turn being accumulated.
		return ev.role === "assistant"
			? { messageId: ev.messageId, parts: [] }
			: turn;
	}
	if (!isMessageContentEvent(ev)) return turn;
	// tool_call_end only ever resolves a part an open snapshot already holds;
	// with no snapshot there is nothing to fill in, and adopting its messageId
	// would open one containing no tool call to match.
	if (!turn && ev.type === "tool_call_end") return turn;

	const t = turn ?? { messageId: ev.messageId, parts: [] };
	const parts = applyEventToParts(t.parts, ev);
	return parts === t.parts ? turn : { messageId: t.messageId, parts };
}

/**
 * Re-express a live-turn snapshot as the minimal event sequence a client
 * that missed the turn's start needs to catch up: one message_start, then
 * the parts in stream order (each text part as a single token chunk, each
 * tool call as start + end-if-resolved). Applying these through
 * {@link applyEventToLiveTurn} reproduces the same snapshot, so replayed and
 * live-from-the-start subscribers converge on identical state.
 */
export function liveTurnReplayEvents(turn: LiveTurn): AgentStreamEvent[] {
	const events: AgentStreamEvent[] = [
		{ type: "message_start", messageId: turn.messageId, role: "assistant" },
	];
	for (const part of turn.parts) {
		if (part.type === "text") {
			events.push({
				type: "token",
				messageId: turn.messageId,
				chunk: part.text,
			});
		} else {
			events.push({
				type: "tool_call_start",
				messageId: turn.messageId,
				callId: part.callId,
				tool: part.tool,
				input: part.input,
			});
			if (part.output !== null || part.error !== undefined) {
				events.push({
					type: "tool_call_end",
					messageId: turn.messageId,
					callId: part.callId,
					output: part.output,
					error: part.error,
				});
			}
		}
	}
	return events;
}
