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

	it("since=0 includes every row regardless of age", () => {
		const summary = getUsageSummary(0);
		expect(summary.totals.inputTokens).toBeGreaterThanOrEqual(400);
	});
});
