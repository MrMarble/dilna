import type { AgentStreamEvent } from "./events";
import type { MessagePart } from "./messages";

/**
 * The merging rules that turn a stream of `AgentStreamEvent`s back into the
 * assistant message they describe — the contract's *meaning*, shared by both
 * sides that have to reconstruct it:
 *
 * - `apps/server`'s `sessions/liveTurn.ts` keeps one snapshot per active
 *   Session, so a subscriber that connects mid-turn can be replayed the turn
 *   so far (the events themselves are emitted once and not retained).
 * - `apps/web`'s `ChatShell` keeps a map of them, so the turn renders while
 *   it streams.
 *
 * Both used to implement these rules independently, bound only by a doc
 * comment asserting they matched. A divergence would have shown up as a tab
 * that reloads mid-turn rendering a different turn than the tab that watched
 * it stream — exactly what ADR-0016 §4/§5's replay rules exist to prevent —
 * and only the server copy had tests. Hence one implementation here, in the
 * package that already owns the event union itself (ADR-0001).
 *
 * Deliberately *not* included: which message an event belongs to, and
 * anything with a lifetime beyond the parts. The two consumers legitimately
 * differ there — the server holds a single `LiveTurn | null` because one
 * assistant message exists per turn, while the client keys a record by
 * `messageId` and tags each entry with a `startedAt` for its timestamp — so
 * ownership stays with each consumer and only the part-merging is shared.
 */

/** Fold one content-carrying event into a message's accumulated parts.
 *
 * Returns `parts` unchanged (by reference, so callers can use identity to
 * skip a state update) for every event that carries no message content —
 * status, usage, diff, notice, thinking, and the message-lifecycle events.
 * Callers are expected to have already resolved *which* message the event
 * addresses; this only merges. */
export function applyEventToParts(
	parts: MessagePart[],
	ev: AgentStreamEvent,
): MessagePart[] {
	switch (ev.type) {
		case "token": {
			// Streamed chunks join the trailing text part so a sentence arrives
			// as one part; a chunk that lands right after a tool call opens a new
			// one instead, preserving the real text/tool_call interleaving order.
			const last = parts[parts.length - 1];
			return last?.type === "text"
				? [...parts.slice(0, -1), { type: "text", text: last.text + ev.chunk }]
				: [...parts, { type: "text", text: ev.chunk }];
		}
		case "tool_call_start":
			return [
				...parts,
				{
					type: "tool_call",
					callId: ev.callId,
					tool: ev.tool,
					input: ev.input,
					// null = still running; the resolved output arrives later via
					// tool_call_end (see ChatShell's ToolCallMarker, which renders a
					// null output as an in-flight spinner rather than empty output).
					output: null,
				},
			];
		case "tool_call_end": {
			// Fills the matching part in place rather than appending, so a tool
			// call and its result stay one part in stream order. A callId that
			// matches nothing returns the same reference rather than a fresh
			// array, so "nothing changed" stays detectable by identity — a
			// tool_call_end can arrive for a message whose start this consumer
			// missed, and the client uses that identity to skip a re-render.
			const i = parts.findIndex(
				(p) => p.type === "tool_call" && p.callId === ev.callId,
			);
			const match = i === -1 ? undefined : parts[i];
			if (match?.type !== "tool_call") return parts;
			const next = [...parts];
			next[i] = { ...match, output: ev.output, error: ev.error };
			return next;
		}
		default:
			return parts;
	}
}

/** Whether an event carries assistant message content, i.e. whether
 * {@link applyEventToParts} would do anything with it. Lets a consumer that
 * keys messages by id decide whether to *create* an entry for a message it
 * has never seen a `message_start` for — the mid-turn-subscribe case, where
 * dropping the event would leave a tool-heavy turn rendering nothing at
 * all. */
export function isMessageContentEvent(
	ev: AgentStreamEvent,
): ev is Extract<
	AgentStreamEvent,
	{ type: "token" | "tool_call_start" | "tool_call_end" }
> {
	return (
		ev.type === "token" ||
		ev.type === "tool_call_start" ||
		ev.type === "tool_call_end"
	);
}
