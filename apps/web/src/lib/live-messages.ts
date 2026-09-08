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
