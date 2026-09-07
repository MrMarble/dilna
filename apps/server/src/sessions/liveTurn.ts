import type { AgentStreamEvent, MessagePart } from "@dilna/shared";

/**
 * The in-flight turn's assistant message accumulated so far, mirrored
 * server-side from the same events broadcast to subscribers (same merging
 * rules as ChatShell's live state: streamed chunks join the trailing text
 * part, tool results fill their tool_call part in place). Kept in memory on
 * the ActiveAgent — never persisted; the DB stays the sole durable record
 * (ADR-0004/0014). Its purpose is the mid-turn subscribe gap: `message_start`
 * and earlier tool/token events are emitted once, so a subscriber that
 * connects mid-turn (page reload, second device) would otherwise render
 * nothing until the turn's next text token.
 */
export type LiveTurn = { messageId: string; parts: MessagePart[] };

/** Fold one broadcast event into the session's live-turn snapshot. Events
 * that don't carry message content (status, usage, diff, crash) pass the
 * snapshot through untouched. */
export function applyEventToLiveTurn(
	turn: LiveTurn | null,
	ev: AgentStreamEvent,
): LiveTurn | null {
	switch (ev.type) {
		case "message_start":
			// One assistant messageId per turn (see NormalizeState in
			// agents/claude.ts), so a start simply opens a fresh snapshot.
			return ev.role === "assistant"
				? { messageId: ev.messageId, parts: [] }
				: turn;
		case "token": {
			const t = turn ?? { messageId: ev.messageId, parts: [] };
			const last = t.parts[t.parts.length - 1];
			const parts: MessagePart[] =
				last?.type === "text"
					? [
							...t.parts.slice(0, -1),
							{ type: "text", text: last.text + ev.chunk },
						]
					: [...t.parts, { type: "text", text: ev.chunk }];
			return { messageId: t.messageId, parts };
		}
		case "tool_call_start": {
			const t = turn ?? { messageId: ev.messageId, parts: [] };
			return {
				messageId: t.messageId,
				parts: [
					...t.parts,
					{
						type: "tool_call",
						callId: ev.callId,
						tool: ev.tool,
						input: ev.input,
						// null = still running, matching the client's convention for
						// an unresolved tool call (see ChatShell's ToolCallMarker).
						output: null,
					},
				],
			};
		}
		case "tool_call_end":
			if (!turn) return turn;
			return {
				messageId: turn.messageId,
				parts: turn.parts.map((p) =>
					p.type === "tool_call" && p.callId === ev.callId
						? { ...p, output: ev.output, error: ev.error }
						: p,
				),
			};
		default:
			return turn;
	}
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
