import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../db";
import { truncatedOutputs as truncatedOutputsTable } from "../db/schema";
import {
	hasTruncated,
	pruneTruncated,
	readTruncated,
	storeTruncated,
	TRUNCATED_RETENTION_DAYS,
} from "./truncatedStore";

let dataDir: string;
let oldDataDir: string | undefined;

const sha256 = (text: string) =>
	createHash("sha256").update(text).digest("hex");

const ORIGINAL = Array.from(
	{ length: 400 },
	(_, i) => `line ${i}: the full original output`,
).join("\n");

beforeAll(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-truncated-store-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;
});

afterAll(() => {
	closeDb();
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
});

function stored(overrides?: { sessionId?: string; content?: string }) {
	const content = overrides?.content ?? ORIGINAL;
	return {
		hash: sha256(content),
		tool: "read",
		path: "src/big.ts",
		sessionId: overrides?.sessionId ?? "s1",
		originalChars: content.length,
		originalLines: content.split("\n").length,
		content,
	};
}

describe("truncatedStore (issue #273)", () => {
	it("round-trips: store writes the file, read returns the exact original", () => {
		const s = stored();
		storeTruncated(s);
		expect(readTruncated(s.hash)).toBe(ORIGINAL);
		expect(hasTruncated(s.hash)).toBe(true);
		expect(readTruncated(sha256("never stored"))).toBeNull();
	});

	it("stores identical content once — two trims never diverge", () => {
		// Different Sessions trimming the same content: the second store is a
		// no-op on both file and row (content-addressed by design).
		storeTruncated(stored({ sessionId: "s2" }));
		const rows = getDb()
			.select({ sessionId: truncatedOutputsTable.sessionId })
			.from(truncatedOutputsTable)
			.where(eq(truncatedOutputsTable.hash, sha256(ORIGINAL)))
			.all();
		expect(rows).toHaveLength(1);
		// Provenance stays with the FIRST session that stored it.
		expect(rows[0]?.sessionId).toBe("s1");
		// ...and the content is identical, not divergent copies.
		expect(readTruncated(sha256(ORIGINAL))).toBe(ORIGINAL);
	});

	it("prunes entries older than the retention window, keeps fresh ones", () => {
		// A second, older entry: stored, then backdated past retention.
		const old = stored({ content: `${ORIGINAL}\nstale` });
		storeTruncated(old);
		const staleStamp =
			Math.floor(Date.now() / 1000) - (TRUNCATED_RETENTION_DAYS + 1) * 86_400;
		getDb()
			.update(truncatedOutputsTable)
			.set({ createdAt: staleStamp })
			.where(eq(truncatedOutputsTable.hash, old.hash))
			.run();
		// Backdate the file's mtime too — the sweep unlinks by row, but be
		// honest about what the filesystem looks like after 31 days.
		const file = path.join(dataDir, "truncated", `${old.hash}.txt`);
		const stale = new Date(
			Date.now() - (TRUNCATED_RETENTION_DAYS + 1) * 86_400_000,
		);
		utimesSync(file, stale, stale);

		const pruned = pruneTruncated();
		expect(pruned).toBe(1);
		expect(existsSync(file)).toBe(false);
		expect(readTruncated(old.hash)).toBeNull();
		// The fresh entry survives untouched.
		expect(readTruncated(sha256(ORIGINAL))).toBe(ORIGINAL);
	});

	it("prunes cleanly when nothing is stale", () => {
		expect(pruneTruncated()).toBe(0);
	});
});
