import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Message } from "@dilna/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../db";
import { sessions as sessionsTable } from "../db/schema";
import * as messageStore from "./messageStore";
import {
	readTruncated,
	recordRetrieval,
	storeTruncationsForRows,
} from "./truncatedStore";
import { getUsageSummary } from "./usageStats";

let dataDir: string;
let oldDataDir: string | undefined;

beforeAll(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-trim-counters-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;
});

afterAll(() => {
	closeDb();
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
});

const sha256 = (text: string) =>
	createHash("sha256").update(text).digest("hex");

const BIG = Array.from(
	{ length: 300 },
	(_, i) => `line ${i}: content content content`,
).join("\n");

function readRow(id: string, sessionId: string, turnId: string): Message {
	return {
		id,
		sessionId,
		role: "assistant",
		parts: [
			{
				type: "tool_call",
				callId: `call-${id}`,
				tool: "read",
				input: { path: "big.txt" },
				output: BIG,
			},
		],
		turnId,
		createdAt: 5,
	};
}

function seedSession(id: string) {
	getDb()
		.insert(sessionsTable)
		.values({
			id,
			repoId: "repo-1",
			worktreePath: `/tmp/wt-${id}`,
			worktreeDirName: id,
			branchName: `agent/${id}`,
		})
		.run();
}

describe("truncation counters (issue #274)", () => {
	it("counts a re-read when a session reads a path whose hash is already stored", () => {
		seedSession("t1");
		// Turn 1: the first read stores the original — no re-read. The rows
		// go through the real persistence path first, exactly as the manager
		// hands them over.
		const turn1 = readRow("a1", "t1", "turn-1");
		messageStore.persistMessage("t1", turn1);
		storeTruncationsForRows("t1", [turn1]);
		expect(readTruncated(sha256(BIG))).toBe(BIG);
		expect(getUsageSummary(0).truncation.rereads).toBe(0);

		// Turn 2 (the next cold start's seed): the same path, same content —
		// the store already held it, so the counter increments.
		const turn2 = readRow("a2", "t1", "turn-2");
		messageStore.persistMessage("t1", turn2);
		storeTruncationsForRows("t1", [turn2]);
		const summary = getUsageSummary(0);
		expect(summary.truncation.rereads).toBe(1);
		// The saved side: one stored read's trim removes most of 300 lines
		// from the seed (head+tail kept, marker added).
		expect(summary.truncation.savedTokens).toBeGreaterThan(0);
		expect(summary.truncation.bySession.length).toBeGreaterThan(0);
		const bySession = summary.truncation.bySession.find(
			(t) => t.sessionId === "t1",
		);
		expect(bySession?.rereads).toBe(1);
	});

	it("counts a retrieval when the original is recorded as opened", () => {
		seedSession("t2");
		const row = readRow("a-t2", "t2", "turn-1");
		messageStore.persistMessage("t2", row);
		storeTruncationsForRows("t2", [row]);
		recordRetrieval(sha256(BIG), "t2");
		recordRetrieval(sha256(BIG), "t2");
		const summary = getUsageSummary(0);
		expect(summary.truncation.retrievals).toBe(2);
		expect(
			summary.truncation.bySession.find((t) => t.sessionId === "t2")
				?.retrievals,
		).toBe(2);
		// The hash the marker carries resolves to the exact original.
		expect(readTruncated(sha256(BIG))).toBe(BIG);
	});

	it("keeps a deleted session's counts in the summary", () => {
		seedSession("t3");
		const row = readRow("a-t3", "t3", "turn-1");
		messageStore.persistMessage("t3", row);
		storeTruncationsForRows("t3", [row]);
		// The Session row goes away (SessionManager.delete) — the trade stays.
		getDb().delete(sessionsTable).where(eq(sessionsTable.id, "t3")).run();
		const bySession = getUsageSummary(0).truncation.bySession;
		const t3 = bySession.find((t) => t.sessionId === "t3");
		expect(t3).toBeDefined();
		// No live row to resolve a title from — the UI's deleted-session
		// label takes over.
		expect(t3?.title).toBeNull();
	});
});
