import {
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../db";
import {
	isValidTruncatedHash,
	maybePruneTruncatedOutputs,
	processSeedTrim,
	pruneTruncatedOutputs,
	readTruncatedOutput,
	storeTruncatedOutput,
	TRUNCATED_MAX_AGE_MS,
	truncatedPathFor,
} from "./truncated";
import { getTruncationSummary } from "./truncationEvents";

let dataDir: string;
let oldDataDir: string | undefined;

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const DAY = 24 * 60 * 60 * 1000;

beforeAll(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-truncated-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;
});

afterAll(() => {
	closeDb();
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
});

describe("isValidTruncatedHash", () => {
	it("accepts sha256 hex and nothing else", () => {
		expect(isValidTruncatedHash("c".repeat(64))).toBe(true);
		expect(isValidTruncatedHash("C".repeat(64))).toBe(false); // uppercase
		expect(isValidTruncatedHash("a".repeat(63))).toBe(false); // short
		expect(isValidTruncatedHash(`${"a".repeat(63)}/../../etc`)).toBe(false);
		expect(isValidTruncatedHash("")).toBe(false);
	});
});

describe("truncatedPathFor", () => {
	it("lands the file at <dataDir>/truncated/<hash>", () => {
		expect(truncatedPathFor(HASH_A)).toBe(
			path.join(dataDir, "truncated", HASH_A),
		);
	});

	it("refuses to build a path from a malformed hash", () => {
		expect(() => truncatedPathFor("../../secret")).toThrow();
	});
});

describe("storeTruncatedOutput / readTruncatedOutput", () => {
	it("round-trips the original under its hash", () => {
		const original = "line 1\nline 2\n".repeat(500);
		storeTruncatedOutput(HASH_A, original);
		expect(readTruncatedOutput(HASH_A)).toBe(original);
	});

	it("is idempotent — the second write of the same hash is a no-op, so identical content trimmed twice is one copy, never divergent", () => {
		const before = statSync(truncatedPathFor(HASH_A)).mtimeMs;
		storeTruncatedOutput(HASH_A, "line 1\nline 2\n".repeat(500));
		expect(statSync(truncatedPathFor(HASH_A)).mtimeMs).toBe(before);
		expect(readTruncatedOutput(HASH_A)).toBe("line 1\nline 2\n".repeat(500));
	});

	it("returns null for a missing hash and for a malformed hash, without touching the filesystem", () => {
		expect(readTruncatedOutput(HASH_B)).toBeNull();
		expect(readTruncatedOutput("../../etc/passwd")).toBeNull();
	});

	it("swallows write failures (best-effort by contract)", () => {
		// A hash that validates but whose path can't be created: point the
		// store at a *file* used as a directory.
		const block = path.join(dataDir, "blocker");
		writeFileSync(block, "not a directory");
		const realDir = process.env.DILNA_DATA_DIR;
		process.env.DILNA_DATA_DIR = block;
		try {
			expect(() => storeTruncatedOutput(HASH_B, "x")).not.toThrow();
		} finally {
			process.env.DILNA_DATA_DIR = realDir;
		}
	});
});

describe("pruneTruncatedOutputs", () => {
	it("removes only files older than the max age, and treats a missing directory as empty", () => {
		expect(pruneTruncatedOutputs()).toBe(0); // no directory yet
		storeTruncatedOutput(HASH_B, "keep me");
		// An old stale temp leftover ages out identically.
		const staleTmp = `${truncatedPathFor(HASH_B)}.stale.tmp`;
		writeFileSync(staleTmp, "leftover");

		const dir = path.join(dataDir, "truncated");
		const now = Date.now();
		let pruned = pruneTruncatedOutputs(now, TRUNCATED_MAX_AGE_MS);
		expect(pruned).toBe(0); // everything is fresh

		// Past the horizon, everything written "now" is stale together —
		// including whatever earlier describes stored in this shared dir.
		const before = readdirSync(dir).length;
		expect(before).toBeGreaterThanOrEqual(2);
		pruned = pruneTruncatedOutputs(now + TRUNCATED_MAX_AGE_MS + DAY);
		expect(pruned).toBe(before);
		expect(readdirSync(dir)).toEqual([]);
		expect(readTruncatedOutput(HASH_B)).toBeNull();
	});
});

describe("maybePruneTruncatedOutputs", () => {
	it("throttles to once per interval unless forced", () => {
		storeTruncatedOutput(HASH_B, "throttled");
		const now = Date.now();
		// A forced call ignores the throttle and runs immediately…
		maybePruneTruncatedOutputs(now + TRUNCATED_MAX_AGE_MS + DAY, true);
		expect(readTruncatedOutput(HASH_B)).toBeNull();
		// …and records *that* run as the last prune, so an unforced call just
		// inside the window is throttled away and what we store next survives.
		storeTruncatedOutput(HASH_B, "survives");
		maybePruneTruncatedOutputs(now + TRUNCATED_MAX_AGE_MS + DAY + 1_000);
		expect(readTruncatedOutput(HASH_B)).toBe("survives");
	});
});

describe("processSeedTrim (issue #274's seam)", () => {
	const DEDUP_READ = (hash: string) => ({
		tool: "read",
		seeded: `[dilna trimmed this tool output: identical result to turn 1 (sha256 ${hash.slice(0, 16)})]`,
		original: "same bytes",
		hash,
		originalLines: 1,
		originalChars: "same bytes".length,
		seededLines: 1,
		reason: "dedup" as const,
	});

	it("counts a dedup re-read of a stored hash — and only once per part, however many walks repeat it", () => {
		const hash = "1".repeat(64);
		// First walk: the hash is not stored yet (the first occurrence was
		// never trimmed), so this is NOT a reread — it stores the original
		// and (with savings off, like the transcript route) records nothing.
		processSeedTrim("s-seam", "call-9", DEDUP_READ(hash), {
			provider: "",
			countSavings: false,
		});
		expect(getTruncationSummary(0).rereads).toBe(0);

		// A later walk sees the same dedup part with the hash now stored:
		// that IS the agent having re-read a truncated file.
		processSeedTrim("s-seam", "call-9", DEDUP_READ(hash), {
			provider: "",
			countSavings: false,
		});
		expect(getTruncationSummary(0).rereads).toBe(1);

		// Every further walk of the same history is idempotent (unique index
		// on session + call id) — re-seeding must not inflate the counter.
		processSeedTrim("s-seam", "call-9", DEDUP_READ(hash), {
			provider: "",
			countSavings: false,
		});
		expect(getTruncationSummary(0).rereads).toBe(1);
	});

	it("a reread is never also a saving — the part is one or the other in a walk", () => {
		const hash = "2".repeat(64);
		storeTruncatedOutput(hash, "already stored");
		const before = getTruncationSummary(0);
		processSeedTrim("s-seam", "call-8", DEDUP_READ(hash), {
			provider: "",
			countSavings: true,
		});
		const after = getTruncationSummary(0);
		// The aggregate is cumulative across this file's cases, so assert on
		// the delta this one walk produced.
		expect(after.rereads).toBe(before.rereads + 1);
		expect(after.tokensSaved).toBe(before.tokensSaved);
	});

	it("records seed savings as chars over the provider's chars-per-token", () => {
		const original = `${"x".repeat(4000)}\n${"y".repeat(4000)}`;
		const savedBefore = getTruncationSummary(0).tokensSaved;
		processSeedTrim(
			"s-seam",
			"call-7",
			{
				tool: "read",
				seeded: "head\nmarker\ntail",
				original,
				hash: "3".repeat(64),
				originalLines: 2,
				originalChars: original.length,
				seededLines: 3,
				reason: "size",
			},
			{ provider: "", countSavings: true },
		);
		// Unknown provider → the library default 4 chars/token; the seeded
		// marker's chars don't count as saved.
		expect(getTruncationSummary(0).tokensSaved).toBe(
			savedBefore +
				Math.round((original.length - "head\nmarker\ntail".length) / 4),
		);
	});
});
