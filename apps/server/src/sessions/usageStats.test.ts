import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../db";
import { usageEvents as usageEventsTable } from "../db/schema";
import { getUsageSummary } from "./usageStats";

let dataDir: string;
let oldDataDir: string | undefined;

beforeAll(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-usage-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;
});

afterAll(() => {
	closeDb();
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
});

const DAY = 86_400;

function seedRow(overrides: {
	id: string;
	repoId: string;
	createdAt: number;
	inputTokens?: number;
	outputTokens?: number;
	costUsd?: number;
	purpose?: string;
	sessionId?: string;
	provider?: string;
	model?: string;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	estimatedContextTokens?: number;
	providerContextTokens?: number;
	toolFactsJson?: string;
}) {
	getDb()
		.insert(usageEventsTable)
		.values({
			sessionId: "session-1",
			provider: "anthropic",
			model: "claude-opus-5",
			inputTokens: overrides.inputTokens ?? 100,
			outputTokens: overrides.outputTokens ?? 50,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			costUsd: overrides.costUsd ?? 0.01,
			...overrides,
		})
		.run();
}

describe("getUsageSummary", () => {
	it("returns zeroed totals and empty breakdowns for an empty range", () => {
		const summary = getUsageSummary(Math.floor(Date.now() / 1000) + DAY);
		expect(summary.totals).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			reasoningTokens: 0,
			costUsd: 0,
			// Nothing to measure is null, never a misleading 0% (issue #266).
			cacheHitRate: null,
		});
		expect(summary.daily).toEqual([]);
		expect(summary.dailyByModel).toEqual([]);
		expect(summary.byRepo).toEqual([]);
		expect(summary.byModel).toEqual([]);
	});

	it("sums totals and groups by day/repo/model within range, excludes rows before it", () => {
		const now = Math.floor(Date.now() / 1000);
		seedRow({ id: "a", repoId: "repo-1", createdAt: now, costUsd: 0.01 });
		seedRow({ id: "b", repoId: "repo-1", createdAt: now, costUsd: 0.02 });
		seedRow({
			id: "c",
			repoId: "repo-2",
			createdAt: now - DAY,
			costUsd: 0.05,
		});
		seedRow({
			id: "old",
			repoId: "repo-1",
			createdAt: now - 10 * DAY,
			costUsd: 100,
		});

		const summary = getUsageSummary(now - 2 * DAY);

		expect(summary.totals.costUsd).toBeCloseTo(0.08);
		expect(summary.totals.inputTokens).toBe(300);
		expect(summary.daily).toHaveLength(2);

		expect(summary.byRepo).toHaveLength(2);
		// repo-2's single 0.05 row outranks repo-1's combined 0.03.
		expect(summary.byRepo[0]).toMatchObject({
			repoId: "repo-2",
			costUsd: 0.05,
		});
		expect(summary.byRepo[1]).toMatchObject({
			repoId: "repo-1",
			costUsd: 0.03,
		});

		expect(summary.byModel).toEqual([
			expect.objectContaining({
				provider: "anthropic",
				model: "claude-opus-5",
			}),
		]);

		// a+b share a day/model (0.03 combined), c is a different day.
		expect(summary.dailyByModel).toHaveLength(2);
		expect(summary.dailyByModel).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					provider: "anthropic",
					model: "claude-opus-5",
					costUsd: expect.closeTo(0.03, 6),
				}),
				expect.objectContaining({
					provider: "anthropic",
					model: "claude-opus-5",
					costUsd: 0.05,
				}),
			]),
		);
	});

	it("computes the cache hit rate per slice, null where there is nothing to measure (issue #266)", () => {
		const now = Math.floor(Date.now() / 1000);
		const before = getUsageSummary(0);

		// Healthy turn: 300 of the 450 prompt-side tokens served from cache.
		seedRow({
			id: "cache-a",
			repoId: "cache-repo-1",
			sessionId: "cache-session-1",
			provider: "p1",
			model: "m1",
			createdAt: now,
			inputTokens: 100,
			cacheReadTokens: 300,
			cacheWriteTokens: 50,
		});
		// Write-heavy turn on every cut: everything re-written, nothing read.
		seedRow({
			id: "cache-b",
			repoId: "cache-repo-2",
			sessionId: "cache-session-2",
			provider: "p1",
			model: "m2",
			createdAt: now,
			inputTokens: 10,
			cacheReadTokens: 0,
			cacheWriteTokens: 90,
		});
		// A fully-cached turn two days back, so the per-day trend gets its own
		// bucket nobody else seeded.
		seedRow({
			id: "cache-c",
			repoId: "cache-repo-1",
			sessionId: "cache-session-1",
			provider: "p1",
			model: "m1",
			createdAt: now - 2 * DAY,
			inputTokens: 0,
			cacheReadTokens: 500,
			cacheWriteTokens: 0,
		});
		// An output-only turn four days back: prompt-side denominator 0 —
		// the rate must read as null ("nothing to measure"), not 0%.
		seedRow({
			id: "cache-d",
			repoId: "cache-repo-3",
			sessionId: "cache-session-3",
			provider: "p1",
			model: "m3",
			createdAt: now - 4 * DAY,
			inputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		});

		const summary = getUsageSummary(0);

		// Totals pool every slice's components before dividing — never a
		// ratio-of-ratios.
		const read = before.totals.cacheReadTokens + 300 + 0 + 500 + 0;
		const write = before.totals.cacheWriteTokens + 50 + 90 + 0 + 0;
		const uncached = before.totals.inputTokens + 100 + 10 + 0 + 0;
		expect(summary.totals.cacheHitRate).toBeCloseTo(
			read / (read + write + uncached),
			6,
		);

		const repo1 = summary.byRepo.find((r) => r.repoId === "cache-repo-1");
		const repo2 = summary.byRepo.find((r) => r.repoId === "cache-repo-2");
		const repo3 = summary.byRepo.find((r) => r.repoId === "cache-repo-3");
		// cache-a + cache-c pool: 800 read of a 950 prompt-side denominator.
		expect(repo1?.cacheHitRate).toBeCloseTo(800 / 950, 6);
		expect(repo2?.cacheHitRate).toBe(0);
		expect(repo3?.cacheHitRate).toBeNull();

		const model1 = summary.byModel.find((m) => m.model === "m1");
		const model2 = summary.byModel.find((m) => m.model === "m2");
		const model3 = summary.byModel.find((m) => m.model === "m3");
		expect(model1?.cacheHitRate).toBeCloseTo(800 / 950, 6);
		expect(model2?.cacheHitRate).toBe(0);
		expect(model3?.cacheHitRate).toBeNull();

		const session1 = summary.topSessions.find(
			(s) => s.sessionId === "cache-session-1",
		);
		const session2 = summary.topSessions.find(
			(s) => s.sessionId === "cache-session-2",
		);
		expect(session1?.cacheHitRate).toBeCloseTo(800 / 950, 6);
		expect(session2?.cacheHitRate).toBe(0);

		const dayOf = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
		const coldDay = summary.daily.find((d) => d.date === dayOf(now - 2 * DAY));
		expect(coldDay?.cacheHitRate).toBe(1);
		const emptyDay = summary.daily.find((d) => d.date === dayOf(now - 4 * DAY));
		expect(emptyDay?.cacheHitRate).toBeNull();
	});

	it("lists Sessions whose estimate drifts past the threshold, worst first (issue #270)", () => {
		const now = Math.floor(Date.now() / 1000);
		// Over-counting: dilna says 2000 where the provider reported 1000.
		for (let i = 0; i < 3; i++) {
			seedRow({
				id: `drift-over-${i}`,
				repoId: "repo-drift",
				sessionId: "drift-over",
				createdAt: now,
				estimatedContextTokens: 2000,
				providerContextTokens: 1000,
			});
		}
		// Under-counting — the dangerous direction (compaction fires late).
		seedRow({
			id: "drift-under-0",
			repoId: "repo-drift",
			sessionId: "drift-under",
			createdAt: now,
			estimatedContextTokens: 400,
			providerContextTokens: 1000,
		});
		seedRow({
			id: "drift-under-1",
			repoId: "repo-drift",
			sessionId: "drift-under",
			createdAt: now,
			estimatedContextTokens: 600,
			providerContextTokens: 1000,
		});
		// Within the threshold — must not be listed.
		seedRow({
			id: "drift-ok-0",
			repoId: "repo-drift",
			sessionId: "drift-ok",
			createdAt: now,
			estimatedContextTokens: 1100,
			providerContextTokens: 1000,
		});
		// Half-stamped rows (either side missing) are not comparable turns.
		seedRow({
			id: "drift-partial-0",
			repoId: "repo-drift",
			sessionId: "drift-partial",
			createdAt: now,
			estimatedContextTokens: 9000,
		});
		seedRow({
			id: "drift-partial-1",
			repoId: "repo-drift",
			sessionId: "drift-partial",
			createdAt: now,
			providerContextTokens: 100,
		});

		const summary = getUsageSummary(0);
		const listed = summary.contextDrift;

		expect(listed.map((d) => d.sessionId)).toEqual([
			"drift-over",
			"drift-under",
		]);
		// Mean signed drift, not max: +100% and -50% respectively.
		const over = listed.find((d) => d.sessionId === "drift-over");
		const under = listed.find((d) => d.sessionId === "drift-under");
		expect(over?.driftPct).toBeCloseTo(1, 6);
		expect(over?.turns).toBe(3);
		expect(under?.driftPct).toBeCloseTo(-0.5, 6);
		expect(under?.turns).toBe(2);
		// No live/archive row for these ids — title falls back to null for
		// the web's deleted-session rendering.
		expect(over?.title).toBeNull();
		expect(over?.repoId).toBe("repo-drift");
	});

	it("folds per-turn tool facts into per-tool/per-skill rows, worst first (issue #292)", () => {
		const now = Math.floor(Date.now() / 1000);
		// Two turns in two Sessions both calling bash and loading tdd — calls
		// sum, Sessions dedupe.
		seedRow({
			id: "tf1",
			repoId: "repo-1",
			createdAt: now,
			toolFactsJson: JSON.stringify({
				tools: { bash: 3, read: 1 },
				skills: { tdd: 1 },
			}),
		});
		seedRow({
			id: "tf2",
			repoId: "repo-1",
			createdAt: now,
			sessionId: "session-2",
			toolFactsJson: JSON.stringify({ tools: { bash: 1 }, skills: { tdd: 2 } }),
			inputTokens: 10,
		});
		// A pre-feature turn (no facts) contributes nothing — not a zero.
		seedRow({ id: "tf3", repoId: "repo-1", createdAt: now, inputTokens: 10 });
		// Out of range entirely.
		seedRow({
			id: "tf-old",
			repoId: "repo-1",
			createdAt: now - 10 * DAY,
			toolFactsJson: JSON.stringify({ tools: { bash: 100 } }),
			inputTokens: 10,
		});

		const summary = getUsageSummary(now - 2 * DAY);
		expect(summary.toolUsage).toEqual([
			{ name: "bash", kind: "tool", calls: 4, sessions: 2 },
			{ name: "tdd", kind: "skill", calls: 3, sessions: 2 },
			{ name: "read", kind: "tool", calls: 1, sessions: 1 },
		]);
	});

	it("since=0 includes every row regardless of age", () => {
		const summary = getUsageSummary(0);
		expect(summary.totals.inputTokens).toBeGreaterThanOrEqual(400);
	});

	it("counts judge spend in the totals and splits it out by purpose", () => {
		const now = Math.floor(Date.now() / 1000);
		const before = getUsageSummary(0);
		seedRow({
			id: "judge-1",
			repoId: "repo-a",
			createdAt: now,
			costUsd: 0.5,
			purpose: "judge",
		});
		const summary = getUsageSummary(0);
		expect(summary.totals.costUsd).toBeCloseTo(before.totals.costUsd + 0.5, 6);
		expect(summary.byPurpose).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ purpose: "judge", costUsd: 0.5 }),
				expect.objectContaining({
					purpose: "turn",
					costUsd: expect.closeTo(before.totals.costUsd, 6),
				}),
			]),
		);
	});

	it("excludes judge rows from tool usage — scoring never counts as the Session's own tool work (issue #292)", () => {
		// Kept after the purpose-split test above: the db is file-cumulative,
		// and this file's other tests already own the cost arithmetic. Seeding
		// here only asserts the delta — a judge row must add nothing to
		// toolUsage. recordJudgeUsage writes no facts (pinned in
		// scoring.test.ts), so a judge row reads like every pre-feature row:
		// null column, no contribution.
		const before = getUsageSummary(0).toolUsage;
		seedRow({
			id: "tj1",
			repoId: "repo-1",
			createdAt: Math.floor(Date.now() / 1000),
			purpose: "judge",
			inputTokens: 10,
		});
		expect(getUsageSummary(0).toolUsage).toEqual(before);
	});

	it("excludes judge rows structurally, even if one ever carried facts (issue #292)", () => {
		// Pins the query's purpose = 'turn' filter, not just today's invariant
		// that recordJudgeUsage writes no facts: if a future writer ever
		// stamped facts onto a judge row, the Metrics table must still not
		// count judge calls as the Session's own tool work.
		seedRow({
			id: "tj2",
			repoId: "repo-1",
			createdAt: Math.floor(Date.now() / 1000),
			purpose: "judge",
			inputTokens: 10,
			toolFactsJson: JSON.stringify({ tools: { judge_only_tool: 7 } }),
		});
		expect(
			getUsageSummary(0).toolUsage.find((t) => t.name === "judge_only_tool"),
		).toBeUndefined();
	});
});
