import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Message } from "@dilna/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../db";
import {
	deleteMessage,
	deleteMessagesForSession,
	getMessages,
	pendingUserMessageId,
	persistConverted,
	persistMessage,
	promotePendingUserMessage,
} from "./messageStore";

let dataDir: string;
let oldDataDir: string | undefined;

beforeAll(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-msgstore-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;
});

afterAll(() => {
	closeDb();
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
});

function msg(overrides: Partial<Message> & { id: string }): Message {
	return {
		sessionId: "s1",
		role: "assistant",
		parts: [{ type: "text", text: "hi" }],
		turnId: null,
		createdAt: 1_000,
		...overrides,
	};
}

/**
 * The `messages` persistence layer extracted from SessionManager (issue
 * #149). These reach it directly — previously the timestamp-reconciliation
 * rules below were only exercised through a full turn against a spawned
 * agent, i.e. not at all in CI.
 */
describe("messageStore", () => {
	it("round-trips a message's parts through JSON storage", () => {
		const sessionId = "roundtrip";
		persistMessage(sessionId, {
			id: "m1",
			sessionId,
			role: "assistant",
			turnId: null,
			parts: [
				{ type: "text", text: "running" },
				{
					type: "tool_call",
					callId: "c1",
					tool: "bash",
					input: { command: "ls" },
					output: "a\nb",
				},
			],
			createdAt: 10,
		});

		const [stored] = getMessages(sessionId);
		expect(stored?.role).toBe("assistant");
		expect(stored?.parts).toEqual([
			{ type: "text", text: "running" },
			{
				type: "tool_call",
				callId: "c1",
				tool: "bash",
				input: { command: "ls" },
				output: "a\nb",
			},
		]);
	});

	// Write order, not timestamp order: `createdAt` is a display value and
	// ties constantly at one-second resolution (see the `ordering` block).
	// A row stamped earlier but written later still comes second.
	it("returns a session's messages in write order and scoped to that session", () => {
		persistMessage("ord", msg({ id: "b", sessionId: "ord", createdAt: 200 }));
		persistMessage("ord", msg({ id: "a", sessionId: "ord", createdAt: 100 }));
		persistMessage("other", msg({ id: "x", sessionId: "other" }));

		expect(getMessages("ord").map((m) => m.id)).toEqual(["b", "a"]);
	});

	it("deletes a single message and a whole session's history", () => {
		persistMessage("del", msg({ id: "d1", sessionId: "del" }));
		persistMessage("del", msg({ id: "d2", sessionId: "del", createdAt: 2000 }));

		deleteMessage("del", "d1");
		expect(getMessages("del").map((m) => m.id)).toEqual(["d2"]);

		deleteMessagesForSession("del");
		expect(getMessages("del")).toEqual([]);
	});

	// ADR-0014: a restart or failed turn must never delete the user's
	// message — the placeholder is renamed, keeping content and timestamp,
	// which also frees the stable id for the next turn's beginTurn INSERT.
	describe("pending-user placeholder", () => {
		it("promotes the placeholder to a fresh id, preserving content", () => {
			const sessionId = "promote";
			const pendingId = pendingUserMessageId(sessionId);
			persistMessage(sessionId, {
				id: pendingId,
				sessionId,
				role: "user",
				parts: [{ type: "text", text: "do the thing" }],
				turnId: null,
				createdAt: 500,
			});

			promotePendingUserMessage(sessionId);

			const stored = getMessages(sessionId);
			expect(stored).toHaveLength(1);
			expect(stored[0]?.id).not.toBe(pendingId);
			expect(stored[0]?.parts).toEqual([
				{ type: "text", text: "do the thing" },
			]);
			expect(stored[0]?.createdAt).toBe(500);
		});

		it("is a no-op when no placeholder exists", () => {
			expect(() => promotePendingUserMessage("nothing-pending")).not.toThrow();
			expect(getMessages("nothing-pending")).toEqual([]);
		});
	});

	describe("persistConverted", () => {
		it("skips rows already persisted by id, so an overlapping retry slice is safe", () => {
			const sessionId = "dedup";
			persistMessage(sessionId, msg({ id: "k1", sessionId, createdAt: 10 }));

			persistConverted(sessionId, [
				msg({ id: "k1", sessionId, createdAt: 10 }),
				msg({ id: "k2", sessionId, createdAt: 20 }),
			]);

			expect(getMessages(sessionId).map((m) => m.id)).toEqual(["k1", "k2"]);
		});

		it("does nothing when every row is already known", () => {
			const sessionId = "allknown";
			persistMessage(sessionId, msg({ id: "z1", sessionId, createdAt: 10 }));
			persistConverted(sessionId, [
				msg({ id: "z1", sessionId, createdAt: 10 }),
			]);
			expect(getMessages(sessionId)).toHaveLength(1);
		});

		// Legacy claude.ts-era rows can carry timestamps in the future. A new
		// batch still sorts after them — but by write order now, not by having
		// its displayed timestamps rewritten to clear the future row.
		it("sorts a new batch after a future-stamped row without altering timestamps", () => {
			const sessionId = "shift";
			persistMessage(
				sessionId,
				msg({ id: "future", sessionId, createdAt: 9_000 }),
			);

			persistConverted(sessionId, [
				msg({ id: "n1", sessionId, createdAt: 100 }),
				msg({ id: "n2", sessionId, createdAt: 150 }),
			]);

			const stored = getMessages(sessionId);
			expect(stored.map((m) => m.id)).toEqual(["future", "n1", "n2"]);
			// Displayed times are written through verbatim — ordering is `seq`'s
			// job, so there is no reason to fabricate timestamps.
			const [, n1, n2] = stored;
			expect(n1?.createdAt).toBe(100);
			expect(n2?.createdAt).toBe(150);
		});

		// The reported bug: the user's message rendered *after* the reply it
		// prompted. The turn's rounds are already persisted by the incremental
		// path before the safety net runs, so `maxExisting` is the final
		// round's stamp — and the batch gets shifted above it. The placeholder
		// holding the user's row must not be dragged along by that shift.
		it("leaves the placeholder's timestamp alone when shifting a batch", () => {
			const sessionId = "ordering";
			const pendingId = pendingUserMessageId(sessionId);
			persistMessage(sessionId, {
				id: pendingId,
				sessionId,
				role: "user",
				parts: [{ type: "text", text: "create a pr" }],
				turnId: null,
				createdAt: 1_000,
			});
			// The incremental path wrote this turn's first round while it ran.
			persistMessage(
				sessionId,
				msg({ id: "round-1", sessionId, turnId: "t1", createdAt: 1_005 }),
			);

			// The safety net writes the round the incremental path missed.
			persistConverted(sessionId, [
				msg({ id: "round-2", sessionId, turnId: "t1", createdAt: 1_009 }),
			]);

			const order = getMessages(sessionId).map((m) => m.id);
			expect(order).toEqual([pendingId, "round-1", "round-2"]);
			expect(
				getMessages(sessionId).find((m) => m.id === pendingId)?.createdAt,
			).toBe(1_000);
		});

		// The reported symptom, stated as an invariant: whatever the clock did,
		// the user's row precedes the rounds that answer it.
		it("keeps the user's row ahead of a round stamped in the same second", () => {
			const sessionId = "tie";
			const pendingId = pendingUserMessageId(sessionId);
			persistMessage(sessionId, {
				id: pendingId,
				sessionId,
				role: "user",
				parts: [{ type: "text", text: "create a pr" }],
				turnId: null,
				createdAt: 4_000,
			});

			persistConverted(sessionId, [
				msg({ id: "answer", sessionId, turnId: "t1", createdAt: 4_000 }),
			]);

			expect(getMessages(sessionId).map((m) => m.id)).toEqual([
				pendingId,
				"answer",
			]);
		});
	});

	/**
	 * `created_at` is epoch *seconds*, so rows written inside the same second
	 * tie — and a tie has no defined order in SQL. Sub-agents running in
	 * parallel make that the normal case rather than a rarity: ~14% of rows in
	 * real Sessions already share a second with another row. Ordering is now
	 * carried by a monotonic `seq` instead, with `created_at` kept purely for
	 * display.
	 */
	describe("ordering", () => {
		it("returns rows written in the same second in write order", () => {
			const sessionId = "sameclock";
			for (const id of ["first", "second", "third", "fourth"]) {
				persistMessage(sessionId, msg({ id, sessionId, createdAt: 1_700 }));
			}

			expect(getMessages(sessionId).map((m) => m.id)).toEqual([
				"first",
				"second",
				"third",
				"fourth",
			]);
		});

		// Ordering must not depend on the wall clock at all: a row stamped in
		// the past (clock skew, a legacy future-stamped row's neighbours) still
		// belongs where it was written.
		it("keeps write order even when a later row carries an earlier timestamp", () => {
			const sessionId = "skew";
			persistMessage(
				sessionId,
				msg({ id: "early-write", sessionId, createdAt: 9_000 }),
			);
			persistMessage(
				sessionId,
				msg({ id: "late-write", sessionId, createdAt: 100 }),
			);

			expect(getMessages(sessionId).map((m) => m.id)).toEqual([
				"early-write",
				"late-write",
			]);
		});

		// `seq` is per-table, not per-session: interleaved writes across
		// Sessions must not affect either Session's own relative order.
		it("orders each session independently when writes interleave", () => {
			persistMessage("sx", msg({ id: "x1", sessionId: "sx", createdAt: 5 }));
			persistMessage("sy", msg({ id: "y1", sessionId: "sy", createdAt: 5 }));
			persistMessage("sx", msg({ id: "x2", sessionId: "sx", createdAt: 5 }));
			persistMessage("sy", msg({ id: "y2", sessionId: "sy", createdAt: 5 }));

			expect(getMessages("sx").map((m) => m.id)).toEqual(["x1", "x2"]);
			expect(getMessages("sy").map((m) => m.id)).toEqual(["y1", "y2"]);
		});

		// The placeholder is promoted (its id changes) after the rounds that
		// answer it are already written. Promotion must not move it.
		it("keeps the user's row in place when the placeholder is promoted", () => {
			const sessionId = "promoteorder";
			persistMessage(sessionId, {
				id: pendingUserMessageId(sessionId),
				sessionId,
				role: "user",
				parts: [{ type: "text", text: "go" }],
				turnId: null,
				createdAt: 2_000,
			});
			persistMessage(
				sessionId,
				msg({ id: "reply", sessionId, createdAt: 2_000 }),
			);

			promotePendingUserMessage(sessionId);

			const rows = getMessages(sessionId);
			expect(rows.map((m) => m.role)).toEqual(["user", "assistant"]);
			expect(rows[1]?.id).toBe("reply");
		});
	});
});
