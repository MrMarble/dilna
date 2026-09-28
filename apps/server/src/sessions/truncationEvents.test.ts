import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../db";
import {
	sessionArchive as sessionArchiveTable,
	sessions as sessionsTable,
} from "../db/schema";
import {
	getTruncationSummary,
	recordTruncationEvent,
} from "./truncationEvents";

let dataDir: string;
let oldDataDir: string | undefined;

beforeAll(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-truncation-events-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;
});

afterAll(() => {
	closeDb();
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
});

function seedSessionRow(id: string, title: string) {
	getDb()
		.insert(sessionsTable)
		.values({
			id,
			repoId: "repo-1",
			title,
			worktreePath: `/tmp/wt-${id}`,
			worktreeDirName: id,
			branchName: `agent/${id}`,
		})
		.run();
}

describe("recordTruncationEvent / getTruncationSummary", () => {
	it("aggregates the three kinds, and an empty table reads as all zeros", () => {
		expect(getTruncationSummary(0)).toEqual({
			retrievals: 0,
			rereads: 0,
			tokensSaved: 0,
			bySession: [],
		});

		recordTruncationEvent({
			sessionId: "s1",
			kind: "trim",
			hash: "a".repeat(64),
			tokensSaved: 1200,
		});
		recordTruncationEvent({
			sessionId: "s1",
			kind: "trim",
			hash: "b".repeat(64),
			tokensSaved: 800,
		});
		recordTruncationEvent({
			sessionId: "s1",
			kind: "retrieval",
			hash: "a".repeat(64),
		});
		recordTruncationEvent({
			sessionId: "s2",
			kind: "reread",
			hash: "c".repeat(64),
			callId: "call-1",
		});

		const summary = getTruncationSummary(0);
		expect(summary.tokensSaved).toBe(2000);
		expect(summary.retrievals).toBe(1);
		expect(summary.rereads).toBe(1);
	});

	it("dedupes rereads per (session, call) but never trims or retrievals", () => {
		// The seed walk and the transcript walk can both report the same
		// re-read — the unique index collapses the repeat.
		for (let i = 0; i < 3; i++) {
			recordTruncationEvent({
				sessionId: "s2",
				kind: "reread",
				hash: "c".repeat(64),
				callId: "call-1",
			});
		}
		expect(getTruncationSummary(0).rereads).toBe(1);

		// A different call id is a different re-read.
		recordTruncationEvent({
			sessionId: "s2",
			kind: "reread",
			hash: "c".repeat(64),
			callId: "call-2",
		});
		expect(getTruncationSummary(0).rereads).toBe(2);

		// Trims (call_id null) never collapse — every seed saves again.
		const before = getTruncationSummary(0).tokensSaved;
		recordTruncationEvent({
			sessionId: "s2",
			kind: "trim",
			hash: "d".repeat(64),
			tokensSaved: 50,
		});
		expect(getTruncationSummary(0).tokensSaved).toBe(before + 50);
	});

	it("bounds the slice by `since`", () => {
		const future = Date.now() + 60_000;
		recordTruncationEvent({
			sessionId: "s1",
			kind: "retrieval",
			hash: "e".repeat(64),
		});
		// The row just written carries a now-ish created_at; a slice starting
		// in the future excludes everything.
		const summary = getTruncationSummary(future);
		expect(summary.retrievals).toBe(0);
		expect(summary.tokensSaved).toBe(0);
	});

	it("resolves titles for live and archived (deleted) Sessions — counts outlive their source", () => {
		seedSessionRow("s1", "live session");
		// s2 was deleted: its counts remain, its title comes from the archive
		// row ADR-0024 wrote at delete time.
		getDb()
			.insert(sessionArchiveTable)
			.values({
				sessionId: "s2",
				repoId: "repo-1",
				title: "archived session",
				summary: "final summary",
				createdAt: Date.now(),
			})
			.run();
		// s3 exists nowhere — "unknown" client-side.

		const summary = getTruncationSummary(0);
		const byId = new Map(summary.bySession.map((r) => [r.sessionId, r]));
		expect(byId.get("s1")?.title).toBe("live session");
		expect(byId.get("s2")?.title).toBe("archived session");
		expect(byId.get("s3")).toBeUndefined(); // never recorded anything
	});
});
