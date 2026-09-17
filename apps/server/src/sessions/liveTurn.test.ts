import type { AgentStreamEvent } from "@dilna/shared";
import { describe, expect, it } from "vitest";
import {
	applyEventToLiveTurn,
	type LiveTurn,
	liveTurnReplayEvents,
} from "./liveTurn";

/**
 * The mid-turn-subscribe path: a tab that reloads while the Agent is working
 * catches up from a replay of the live-turn snapshot, so whatever the snapshot
 * can't express simply vanishes from that tab until the turn is persisted.
 *
 * Agent-sent images (issue #222, ADR-0038) are the case that made this matter
 * — before the `image_sent` event existed there was nothing in the stream
 * contract that could carry one.
 */

const attachment = {
	id: "img-1",
	sessionId: "s1",
	filename: "shot.png",
	mimeType: "image/png",
	size: 128,
	kind: "image" as const,
	source: "agent" as const,
	path: "/data/attachments/s1/aa-shot.png",
	createdAt: 41,
};

const start: AgentStreamEvent = {
	type: "message_start",
	messageId: "m1",
	role: "assistant",
};

const fold = (events: AgentStreamEvent[]): LiveTurn | null =>
	events.reduce<LiveTurn | null>(applyEventToLiveTurn, null);

describe("applyEventToLiveTurn", () => {
	it("folds an Agent-sent image into the in-flight snapshot", () => {
		const turn = fold([
			start,
			{ type: "token", messageId: "m1", chunk: "Here:" },
			{ type: "image_sent", messageId: "m1", attachment },
		]);

		expect(turn?.parts).toEqual([
			{ type: "text", text: "Here:" },
			{ type: "attachment", attachment },
		]);
	});

	it("adopts the event's own messageId when the turn's start was missed", () => {
		const turn = fold([{ type: "image_sent", messageId: "m9", attachment }]);
		expect(turn?.messageId).toBe("m9");
		expect(turn?.parts).toHaveLength(1);
	});
});

describe("liveTurnReplayEvents", () => {
	/** The invariant the doc comment claims: replaying a snapshot through the
	 * same fold reproduces it, so a reconnecting subscriber converges on
	 * exactly what a subscriber present from the start already has. */
	it("round-trips a turn containing an image back to the same snapshot", () => {
		const original = fold([
			start,
			{ type: "token", messageId: "m1", chunk: "Here's the homepage:" },
			{ type: "image_sent", messageId: "m1", attachment },
			{ type: "token", messageId: "m1", chunk: "The header is fixed." },
		]);
		if (!original) throw new Error("expected a snapshot");

		const replayed = fold(liveTurnReplayEvents(original));

		expect(replayed).toEqual(original);
	});

	it("replays the image in position, not appended at the end", () => {
		const turn = fold([
			start,
			{ type: "token", messageId: "m1", chunk: "before" },
			{ type: "image_sent", messageId: "m1", attachment },
			{ type: "token", messageId: "m1", chunk: "after" },
		]);
		if (!turn) throw new Error("expected a snapshot");

		expect(liveTurnReplayEvents(turn).map((e) => e.type)).toEqual([
			"message_start",
			"token",
			"image_sent",
			"token",
		]);
	});

	it("round-trips a turn with interleaved tool calls and images", () => {
		const original = fold([
			start,
			{
				type: "tool_call_start",
				messageId: "m1",
				callId: "c1",
				tool: "Bash",
				input: { command: "shoot" },
			},
			{ type: "tool_call_end", messageId: "m1", callId: "c1", output: "ok" },
			{ type: "image_sent", messageId: "m1", attachment },
		]);
		if (!original) throw new Error("expected a snapshot");

		expect(fold(liveTurnReplayEvents(original))).toEqual(original);
	});
});
