import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { primeCustomProviders } from "../agents/customProviders";
import { closeDb, getDb } from "../db";
import {
	customProviders as customProvidersTable,
	sessions as sessionsTable,
	usageEvents as usageEventsTable,
} from "../db/schema";
import { getUsageSummary } from "./usageStats";

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

// claude-haiku-4-5: in the catalog, priced, 200k window — a deep turn is
// providerContextTokens >= 0.7 * 200_000 = 140_000.
const CATALOG_PROVIDER = "anthropic";
const CATALOG_MODEL = "claude-haiku-4-5";
const WINDOW = 200_000;

function seedTurn(overrides: {
	id: string;
	sessionId: string;
	repoId?: string;
	provider?: string;
	model?: string;
	createdAt?: number;
	costUsd?: number;
	providerContextTokens?: number | null;
	purpose?: string;
}) {
	getDb()
		.insert(usageEventsTable)
		.values({
			repoId: "repo-burn",
			provider: CATALOG_PROVIDER,
			model: CATALOG_MODEL,
			createdAt: Math.floor(Date.now() / 1000),
			costUsd: 0.01,
			purpose: "turn",
			...overrides,
		})
		.run();
}

/** Three provider-reported turns at the given depth fractions (against the
 * catalog fixture's window), with per-turn costs. */
function seedDeepSession(sessionId: string, depths: number[], costs: number[]) {
	depths.forEach((depth, i) => {
		seedTurn({
			id: `${sessionId}-${i}`,
			sessionId,
			providerContextTokens: Math.round(depth * WINDOW),
			costUsd: costs[i],
		});
	});
}

/** Insert a live `sessions` row (defaults suffice — only compaction state
 * and title matter here). */
function seedSessionRow(
	id: string,
	{ title, compacted }: { title?: string; compacted?: boolean },
) {
	getDb()
		.insert(sessionsTable)
		.values({
			id,
			repoId: "repo-burn",
			worktreePath: `/tmp/${id}`,
			worktreeDirName: id,
			branchName: `${id}-branch`,
			title: title ?? `Session ${id}`,
			...(compacted ? { compactedSummary: "earlier context, summarized" } : {}),
		})
		.run();
}

const findingsFor = (...sessionIds: string[]) =>
	getUsageSummary(0).burnFindings.filter((f) =>
		sessionIds.includes(f.sessionId ?? ""),
	);

describe("getBurnFindings (finding D — session overdepth)", () => {
	it("fires exactly at the depth threshold and not below it (issue #291 boundary)", () => {
		seedDeepSession("burn-boundary", [0.7, 0.7, 0.72], [0.1, 0.1, 0.1]);
		seedDeepSession("burn-shallow", [0.69, 0.7 - 0.005, 0.65], [0.1, 0.1, 0.1]);

		const findings = findingsFor("burn-boundary", "burn-shallow");
		expect(findings).toHaveLength(1);
		expect(findings[0]?.sessionId).toBe("burn-boundary");
		expect(findings[0]?.check).toBe("session-overdepth");
		// 0.7 is below the critical bar — a warning, not critical.
		expect(findings[0]?.severity).toBe("warning");
		expect(findings[0]?.wasteUsd).toBe(0);
	});

	it("skips Sessions with too few reported turns or no deep turns at all", () => {
		// Two deep turns is a one-off, not persistence.
		seedDeepSession("burn-two-turns", [0.9, 0.9], [0.2, 0.2]);
		// Three reported turns, all shallow.
		seedDeepSession("burn-not-deep", [0.2, 0.3, 0.4], [0.01, 0.01, 0.01]);
		// Rows predating the provider stamp are not comparable turns.
		seedTurn({
			id: "burn-unstamped-0",
			sessionId: "burn-unstamped",
			providerContextTokens: null,
		});
		seedTurn({
			id: "burn-unstamped-1",
			sessionId: "burn-unstamped",
			providerContextTokens: null,
		});
		seedTurn({
			id: "burn-unstamped-2",
			sessionId: "burn-unstamped",
			providerContextTokens: null,
		});

		expect(
			findingsFor("burn-two-turns", "burn-not-deep", "burn-unstamped"),
		).toEqual([]);
	});

	it("never counts judge calls toward a Session's depth", () => {
		for (let i = 0; i < 3; i++) {
			seedTurn({
				id: `burn-judge-${i}`,
				sessionId: "burn-judge-only",
				providerContextTokens: Math.round(0.95 * WINDOW),
				purpose: "judge",
			});
		}
		expect(findingsFor("burn-judge-only")).toEqual([]);
	});

	it("estimates waste as the depth premium over the Session's own median turn, worst first (issue #291)", () => {
		// Critical: median depth 0.9; deep-turn premium over the median cost.
		seedDeepSession(
			"burn-critical",
			[0.9, 0.9, 0.9],
			[0.5, 0.4, 0.1], // median 0.4 → premium (0.5-0.4) + 0 + 0 (clamped)
		);
		// Warning with less waste — must rank second.
		seedDeepSession(
			"burn-warning",
			[0.75, 0.75, 0.75],
			[0.06, 0.05, 0.04], // median 0.05 → premium 0.01
		);

		const findings = findingsFor("burn-critical", "burn-warning");
		expect(findings.map((f) => f.sessionId)).toEqual([
			"burn-critical",
			"burn-warning",
		]);
		expect(findings[0]?.severity).toBe("critical");
		expect(findings[0]?.wasteUsd).toBeCloseTo(0.1, 6);
		expect(findings[1]?.severity).toBe("warning");
		expect(findings[1]?.wasteUsd).toBeCloseTo(0.01, 6);

		// Evidence is self-contained: shares, counts, and the $ figure.
		expect(findings[0]?.evidence).toContain("90%");
		expect(findings[0]?.evidence).toContain("3 of 3");
		expect(findings[0]?.evidence).toContain("$0.10");
		expect(findings[1]?.evidence).toContain("75%");
	});

	it("resolves titles and corroborates with the Session's compaction state", () => {
		seedDeepSession("burn-compacted", [0.8, 0.8, 0.8], [0.2, 0.2, 0.2]);
		seedDeepSession("burn-fresh", [0.8, 0.8, 0.8], [0.2, 0.2, 0.2]);
		seedDeepSession("burn-deleted", [0.8, 0.8, 0.8], [0.2, 0.2, 0.2]);
		seedSessionRow("burn-compacted", {
			title: "Deep diver",
			compacted: true,
		});
		seedSessionRow("burn-fresh", { title: "Shallow start", compacted: false });

		const findings = findingsFor(
			"burn-compacted",
			"burn-fresh",
			"burn-deleted",
		);
		const byId = new Map(findings.map((f) => [f.sessionId, f]));

		expect(byId.get("burn-compacted")?.title).toBe("Deep diver");
		expect(byId.get("burn-compacted")?.evidence).toContain("already compacted");
		expect(byId.get("burn-fresh")?.evidence).toContain("never compacted");
		// Deleted Session: archive carries no compaction state, so the
		// evidence omits the compaction sentence; title falls back to null.
		expect(byId.get("burn-deleted")?.title).toBeNull();
		expect(byId.get("burn-deleted")?.evidence).not.toContain("compact");
	});

	it("omits the $ figure for a model with no price in the catalog, but still fires (issue #291)", () => {
		// A custom-provider model: resolvable (buildCustomModel, 128k window)
		// but built with an all-zero cost — the "unpriced" case.
		getDb()
			.insert(customProvidersTable)
			.values({
				id: "burntestbox",
				name: "Burn Test Box",
				baseUrl: "http://localhost:1",
				api: "openai-completions",
				modelsJson: JSON.stringify([{ id: "ghost-9" }]),
			})
			.run();
		primeCustomProviders();

		// pi can't bill an unpriced model: recorded cost is all zeros. Depths
		// are against the custom model's own 128k window, so this also proves
		// the window comes from the resolved Model, not the catalog fixture's.
		const CUSTOM_WINDOW = 128_000;
		[0.8, 0.8, 0.8].forEach((depth, i) => {
			seedTurn({
				id: `burn-unpriced-${i}`,
				sessionId: "burn-unpriced",
				provider: "burntestbox",
				model: "ghost-9",
				providerContextTokens: Math.round(depth * CUSTOM_WINDOW),
				costUsd: 0,
			});
		});
		const findings = findingsFor("burn-unpriced");
		expect(findings).toHaveLength(1);
		expect(findings[0]?.wasteUsd).toBeNull();
		expect(findings[0]?.evidence).toContain("no price in the catalog");
		expect(findings[0]?.evidence).not.toContain("$");
		expect(findings[0]?.evidence).toContain("128k");
	});

	it("returns no findings for an empty range while keeping the summary shape", () => {
		const summary = getUsageSummary(Math.floor(Date.now() / 1000) + 86_400);
		expect(summary.burnFindings).toEqual([]);
	});
});
