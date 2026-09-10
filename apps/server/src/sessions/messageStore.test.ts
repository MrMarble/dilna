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

	it("returns a session's messages oldest-first and scoped to that session", () => {
		persistMessage("ord", msg({ id: "b", sessionId: "ord", createdAt: 200 }));
		persistMessage("ord", msg({ id: "a", sessionId: "ord", createdAt: 100 }));
		persistMessage("other", msg({ id: "x", sessionId: "other" }));

		expect(getMessages("ord").map((m) => m.id)).toEqual(["a", "b"]);
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

			const result = persistConverted(sessionId, [
				msg({ id: "k1", sessionId, createdAt: 10 }),
				msg({ id: "k2", sessionId, createdAt: 20 }),
			]);

			expect(result.persistedUserMessage).toBe(false);
			expect(getMessages(sessionId).map((m) => m.id)).toEqual(["k1", "k2"]);
		});

		it("reports a freshly persisted user row (drives the placeholder's fate)", () => {
			const sessionId = "userrow";
			const result = persistConverted(sessionId, [
				msg({ id: "u1", sessionId, role: "user", createdAt: 10 }),
			]);
			expect(result.persistedUserMessage).toBe(true);
		});

		it("does nothing and reports no user row when every row is already known", () => {
			const sessionId = "allknown";
			persistMessage(
				sessionId,
				msg({ id: "z1", sessionId, role: "user", createdAt: 10 }),
			);
			const result = persistConverted(sessionId, [
				msg({ id: "z1", sessionId, role: "user", createdAt: 10 }),
			]);
			expect(result.persistedUserMessage).toBe(false);
			expect(getMessages(sessionId)).toHaveLength(1);
		});

		// Legacy claude.ts-era rows can carry timestamps in the future; a new
		// batch must still sort after them rather than interleaving into the
		// middle of the rendered transcript.
		it("shifts a batch above existing future-stamped rows to keep ordering monotonic", () => {
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
			// Relative spacing inside the batch is preserved by the shift.
			const [, n1, n2] = stored;
			expect(n1?.createdAt).toBe(9_001);
			expect(n2?.createdAt).toBe(9_051);
		});

		// So a client that already rendered the optimistic placeholder doesn't
		// see the user's own message jump position after a reload.
		it("keeps the placeholder's timestamp for the turn's real user row", () => {
			const sessionId = "keepstamp";
			const pendingId = pendingUserMessageId(sessionId);
			persistMessage(sessionId, {
				id: pendingId,
				sessionId,
				role: "user",
				parts: [{ type: "text", text: "hello" }],
				turnId: null,
				createdAt: 777,
			});

			persistConverted(sessionId, [
				msg({ id: "real-user", sessionId, role: "user", createdAt: 5 }),
			]);

			const real = getMessages(sessionId).find((m) => m.id === "real-user");
			expect(real?.createdAt).toBe(777);
		});
	});
});
