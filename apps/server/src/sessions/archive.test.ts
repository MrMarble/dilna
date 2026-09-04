import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../db";
import {
	archiveSession,
	getArchivedSession,
	listArchivedSessions,
} from "./archive";

let dataDir: string;
let oldDataDir: string | undefined;

beforeAll(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-archive-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;
});

afterAll(() => {
	closeDb();
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
});

describe("session archive", () => {
	it("returns null for a session that was never archived", () => {
		expect(getArchivedSession("no-such-session")).toBeNull();
	});

	it("writes and reads back a full archived session", () => {
		archiveSession({
			sessionId: "s1",
			repoId: "repo-1",
			title: "Fix the login flow",
			summary: "Investigated and fixed a token refresh race.",
			createdAt: 100,
		});

		const row = getArchivedSession("s1");
		expect(row).toMatchObject({
			sessionId: "s1",
			repoId: "repo-1",
			title: "Fix the login flow",
			summary: "Investigated and fixed a token refresh race.",
			createdAt: 100,
		});
		expect(row?.archivedAt).toBeGreaterThan(0);
	});

	it("excludes summary text from the list view", () => {
		archiveSession({
			sessionId: "s2",
			repoId: "repo-1",
			title: "Add billing",
			summary: "A summary that shouldn't appear in the list.",
			createdAt: 200,
		});

		const [row] = listArchivedSessions("repo-1").filter(
			(r) => r.sessionId === "s2",
		);
		expect(row).toMatchObject({
			sessionId: "s2",
			repoId: "repo-1",
			title: "Add billing",
		});
		expect(row).not.toHaveProperty("summary");
	});

	it("scopes the list by repoId when given", () => {
		archiveSession({
			sessionId: "s3",
			repoId: "repo-2",
			title: "Repo 2 session",
			summary: "irrelevant to repo-1",
			createdAt: 300,
		});

		const repo2Only = listArchivedSessions("repo-2");
		expect(repo2Only.map((r) => r.sessionId)).toEqual(["s3"]);

		const everything = listArchivedSessions();
		expect(everything.map((r) => r.sessionId)).toContain("s3");
		expect(everything.map((r) => r.sessionId)).toContain("s1");
	});
});
