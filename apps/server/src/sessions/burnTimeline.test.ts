import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../db";
import {
	messages as messagesTable,
	sessions as sessionsTable,
	usageEvents as usageEventsTable,
} from "../db/schema";
import { getBurnTimeline } from "./burnTimeline";

let dataDir: string;
let oldDataDir: string | undefined;

beforeAll(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-burn-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;
});

afterAll(() => {
	closeDb();
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
});

function seedSession(
	id: string,
	overrides: { compactedThroughMessageId?: string } = {},
) {
	getDb()
		.insert(sessionsTable)
		.values({
			id,
			repoId: "repo-1",
			worktreePath: `/tmp/${id}`,
			worktreeDirName: id,
			branchName: `${id}-branch`,
			...overrides,
		})
		.run();
}

function seedUsage(
	sessionId: string,
	id: string,
	overrides: {
		createdAt: number;
		purpose?: string;
		inputTokens?: number;
		outputTokens?: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		reasoningTokens?: number;
		costUsd?: number;
		providerContextTokens?: number;
		estimatedContextTokens?: number;
		provider?: string;
		model?: string;
	},
) {
	getDb()
		.insert(usageEventsTable)
		.values({
			id,
			sessionId,
			repoId: "repo-1",
			provider: overrides.provider ?? "anthropic",
			model: overrides.model ?? "claude-opus-5",
			inputTokens: overrides.inputTokens ?? 100,
			outputTokens: overrides.outputTokens ?? 50,
			cacheReadTokens: overrides.cacheReadTokens ?? 0,
			cacheWriteTokens: overrides.cacheWriteTokens ?? 0,
			reasoningTokens: overrides.reasoningTokens ?? 0,
			costUsd: overrides.costUsd ?? 0.01,
			...overrides,
		})
		.run();
}

function seedMessage(
	sessionId: string,
	id: string,
	overrides: {
		role?: string;
		turnId?: string | null;
		seq?: number;
		createdAt?: number;
	} = {},
) {
	getDb()
		.insert(messagesTable)
		.values({
			id,
			sessionId,
			role: overrides.role ?? "user",
			partsJson: "[]",
			turnId: overrides.turnId ?? null,
			seq: overrides.seq ?? null,
			createdAt: overrides.createdAt ?? Math.floor(Date.now() / 1000),
		})
		.run();
}

describe("getBurnTimeline", () => {
	it("returns an empty list for a Session with no usage rows", () => {
		seedSession("burn-empty");
		expect(getBurnTimeline("burn-empty")).toEqual([]);
	});

	it("returns every usage row oldest-first with composition, stamps, and resolved context window", () => {
		seedSession("burn-order");
		// Inserted deliberately out of chronological order; createdAt orders.
		seedUsage("burn-order", "bo-t2", {
			createdAt: 2000,
			inputTokens: 10,
			outputTokens: 20,
			cacheReadTokens: 300,
			cacheWriteTokens: 40,
			reasoningTokens: 5,
			costUsd: 0.02,
			providerContextTokens: 1234,
			estimatedContextTokens: 1300,
		});
		seedUsage("burn-order", "bo-t1", {
			createdAt: 1000,
			inputTokens: 100,
			outputTokens: 50,
			costUsd: 0.01,
			providerContextTokens: 900,
		});
		// A different Session's row must not leak in.
		seedSession("burn-other");
		seedUsage("burn-other", "other", { createdAt: 1500 });

		const turns = getBurnTimeline("burn-order");
		expect(turns).toHaveLength(2);

		expect(turns[0]).toMatchObject({
			turn: 1,
			purpose: "turn",
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			costUsd: 0.01,
			providerContextTokens: 900,
			estimatedContextTokens: null,
			// claude-opus-5, resolved from dilna's catalog.
			contextWindow: 1_000_000,
			compacted: false,
		});
		expect(turns[1]).toMatchObject({
			turn: 2,
			providerContextTokens: 1234,
			estimatedContextTokens: 1300,
			compacted: false,
		});
	});

	it("breaks same-second createdAt ties by insertion order", () => {
		seedSession("burn-ties");
		seedUsage("burn-ties", "bt-later", { createdAt: 1000 });
		seedUsage("burn-ties", "bt-earlier", { createdAt: 1000 });

		const turns = getBurnTimeline("burn-ties");
		expect(turns.map((t) => t.turn)).toEqual([1, 2]);
	});

	it("keeps judge rows as unnumbered purpose-marked entries between turns", () => {
		seedSession("burn-judge");
		seedUsage("burn-judge", "bj-t1", { createdAt: 1000 });
		seedUsage("burn-judge", "bj-j1", {
			createdAt: 1500,
			purpose: "judge",
			inputTokens: 500,
			outputTokens: 10,
			costUsd: 0.004,
		});
		seedUsage("burn-judge", "bj-t2", { createdAt: 2000 });

		const turns = getBurnTimeline("burn-judge");
		expect(turns.map((t) => t.purpose)).toEqual(["turn", "judge", "turn"]);
		// Judge spend doesn't consume a turn number.
		expect(turns.map((t) => t.turn)).toEqual([1, null, 2]);
	});

	it("marks the turn containing the Session's compaction pointer", () => {
		seedSession("burn-compact", { compactedThroughMessageId: "m-t2" });
		// Two turns of messages; the pointer sits in the second turn.
		seedMessage("burn-compact", "m-t1", { turnId: "turn-1", seq: 1 });
		seedMessage("burn-compact", "m-t2", { turnId: "turn-2", seq: 2 });
		seedMessage("burn-compact", "m-t2b", {
			role: "assistant",
			turnId: "turn-2",
			seq: 3,
		});
		seedUsage("burn-compact", "bc-t1", { createdAt: 1000 });
		seedUsage("burn-compact", "bc-t2", { createdAt: 2000 });

		const turns = getBurnTimeline("burn-compact");
		expect(turns.map((t) => t.compacted)).toEqual([false, true]);
	});

	it("marks no turn when the Session was never compacted or the pointer dangles", () => {
		seedSession("burn-nocompact");
		seedUsage("burn-nocompact", "bn-t1", { createdAt: 1000 });

		seedSession("burn-dangling", { compactedThroughMessageId: "missing-msg" });
		seedUsage("burn-dangling", "bd-t1", { createdAt: 1000 });

		expect(getBurnTimeline("burn-nocompact").at(0)?.compacted).toBe(false);
		expect(getBurnTimeline("burn-dangling").at(0)?.compacted).toBe(false);
	});

	it("ignores turnId-less messages when counting the compaction turn", () => {
		seedSession("burn-system", { compactedThroughMessageId: "bs-m-t2" });
		// Boot-time system notice: null turnId, before every turn.
		seedMessage("burn-system", "bs-sys", {
			role: "system",
			turnId: null,
			seq: 0,
		});
		seedMessage("burn-system", "bs-m-t1", { turnId: "turn-1", seq: 1 });
		seedMessage("burn-system", "bs-m-t2", { turnId: "turn-2", seq: 2 });
		seedUsage("burn-system", "bs-t1", { createdAt: 1000 });
		seedUsage("burn-system", "bs-t2", { createdAt: 2000 });

		// Without the null-turnId notice the pointer still lands on turn 2.
		const turns = getBurnTimeline("burn-system");
		expect(turns.map((t) => t.compacted)).toEqual([false, true]);
	});

	it("resolves no context window for a model outside the catalog, without dropping the row", () => {
		seedSession("burn-unknown-model");
		seedUsage("burn-unknown-model", "bu-t1", {
			createdAt: 1000,
			provider: "ollama",
			model: "gone-model",
			providerContextTokens: 500,
		});

		const turns = getBurnTimeline("burn-unknown-model");
		expect(turns).toHaveLength(1);
		expect(turns[0]).toMatchObject({
			contextWindow: null,
			providerContextTokens: 500,
		});
	});
});
