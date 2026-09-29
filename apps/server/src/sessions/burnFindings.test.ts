import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TurnToolFacts } from "@dilna/shared";
import { formatUsd } from "@dilna/shared";
import { eq, like } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { primeCustomProviders } from "../agents/customProviders";
import { resolveSummarizationModel } from "../agents/pi";
import { closeDb, getDb } from "../db";
import {
	customProviders as customProvidersTable,
	messages as messagesTable,
	sessions as sessionsTable,
	turnScores as turnScoresTable,
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
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	reasoningTokens?: number;
	toolFacts?: TurnToolFacts;
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
			...(overrides.toolFacts
				? { toolFactsJson: JSON.stringify(overrides.toolFacts) }
				: {}),
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
 * and title matter here; `createdAt` matters for finding K's carry test). */
function seedSessionRow(
	id: string,
	{
		title,
		compacted,
		repoId,
		createdAt,
	}: {
		title?: string;
		compacted?: boolean;
		repoId?: string;
		createdAt?: number;
	} = {},
) {
	getDb()
		.insert(sessionsTable)
		.values({
			id,
			repoId: repoId ?? "repo-burn",
			worktreePath: `/tmp/${id}`,
			worktreeDirName: id,
			branchName: `${id}-branch`,
			title: title ?? `Session ${id}`,
			...(createdAt != null ? { createdAt } : {}),
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
		// All three turns deep: the all-deep fallback applies — the Session's
		// overall median is the only baseline its data offers, and with equal
		// costs the premium is 0 (the finding still fires).
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

	it("estimates waste as the depth premium over the Session's own normal turns, worst first (issue #291)", () => {
		// All turns deep: the all-deep fallback applies — overall median
		// (0.4) is the baseline, so the premium is 0.5−0.4 (the 0.1 turn is
		// clamped at zero).
		seedDeepSession("burn-critical", [0.9, 0.9, 0.9], [0.5, 0.4, 0.1]);
		// Warning with less waste — must rank second.
		seedDeepSession(
			"burn-warning",
			[0.75, 0.75, 0.75],
			[0.06, 0.05, 0.04], // all-deep fallback: median 0.05 → premium 0.01
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

	it("baselines waste on the Session's normal turns, not the deep ones it penalizes (review fix)", () => {
		// Three deep turns out of five: the median over ALL turns would be a
		// deep turn's own cost (0.4), understating the premium to 0.2. The
		// baseline is the median of the two normal turns (0.045), so the
		// premium reads 0.455 + 0.455 + 0.355 = 1.265.
		seedDeepSession(
			"burn-baseline",
			[0.9, 0.9, 0.9, 0.2, 0.2],
			[0.5, 0.5, 0.4, 0.05, 0.04],
		);
		const findings = findingsFor("burn-baseline");
		expect(findings[0]?.wasteUsd).toBeCloseTo(1.265, 6);
		expect(findings[0]?.evidence).toContain("$1.27");
		expect(findings[0]?.evidence).toContain("3 of 5");
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

/**
 * Findings scoped to a `since` past every earlier fixture: findings are
 * capped worst-first across the whole range (BURN_FINDINGS_LIMIT), so each
 * later describe seeds its turns in the far future and queries a window
 * that only its own rows satisfy — and wipes them afterwards, so the next
 * describe starts from an empty slate. without this, the D-era fixtures'
 * findings crowd the later describes' out of the capped top-10.
 */
const findingsSince = (since: number, ...sessionIds: string[]) =>
	getUsageSummary(since).burnFindings.filter((f) =>
		sessionIds.includes(f.sessionId ?? ""),
	);

/** Delete every fixture row of one describe (usage_events, sessions,
 * messages, turn_scores) by Session-id prefix. */
function wipeBurnFixtures(prefix: string) {
	const db = getDb();
	db.delete(usageEventsTable)
		.where(like(usageEventsTable.sessionId, `${prefix}%`))
		.run();
	db.delete(sessionsTable)
		.where(like(sessionsTable.id, `${prefix}%`))
		.run();
	db.delete(messagesTable)
		.where(like(messagesTable.sessionId, `${prefix}%`))
		.run();
	db.delete(turnScoresTable)
		.where(like(turnScoresTable.sessionId, `${prefix}%`))
		.run();
}

// The catalog fixture's real rate card, for exact-waste assertions: pi-ai
// stores per-Mtok rates on the Model's cost (models.ts divides by 1e6).
const catalogCost = () =>
	resolveSummarizationModel(CATALOG_PROVIDER, CATALOG_MODEL)?.cost;

describe("getBurnFindings (finding C — cache rehydration / compaction tax)", () => {
	// Far-future base + scoped query + cleanup: keeps this describe's
	// findings inside BURN_FINDINGS_LIMIT despite the shared test db.
	const SINCE = 1_999_999_999;
	afterAll(() => wipeBurnFixtures("burn-cache-"));

	/** One reported turn with zero output, so the prefix IS the reported
	 * context: `cacheWrite` tokens re-written against a `prefix`-token
	 * prompt. Ordered by createdAt — the check walks consecutive turns. */
	function seedCacheTurn(
		sessionId: string,
		i: number,
		prefix: number,
		cacheWrite: number,
		overrides: Partial<Parameters<typeof seedTurn>[0]> = {},
	) {
		seedTurn({
			id: `${sessionId}-c${i}`,
			sessionId,
			providerContextTokens: prefix,
			cacheWriteTokens: cacheWrite,
			createdAt: 2_000_000_000 + i,
			...overrides,
		});
	}

	it("counts post-reset re-writes and mid-session spikes separately, firing at two counted turns (issue #294)", () => {
		// t0: first turn re-writes everything — excluded from the tax.
		seedCacheTurn("burn-cache-mixed", 0, 10_000, 10_000);
		// t1: warm — only the new tail is written.
		seedCacheTurn("burn-cache-mixed", 1, 12_000, 2_000);
		// t2: prefix shrank 12k → 7k (12k ≥ 1.5×7k): a re-seed replaced it,
		// and this turn paid to re-write the compacted context.
		seedCacheTurn("burn-cache-mixed", 2, 7_000, 7_000);
		// t3: prefix grew 7k → 9k but the whole thing was re-written: the
		// mid-session broken-prefix signature.
		seedCacheTurn("burn-cache-mixed", 3, 9_000, 9_000);
		// t4: warm again.
		seedCacheTurn("burn-cache-mixed", 4, 13_000, 2_000);

		const findings = findingsSince(SINCE, "burn-cache-mixed");
		expect(findings).toHaveLength(1);
		const f = findings[0];
		expect(f?.check).toBe("cache-rehydration");
		// Two counted turns is exactly the minimum → info (no spikes would
		// be info; one spike is warning; this fixture has one spike).
		expect(f?.severity).toBe("warning");
		expect(f?.evidence).toContain("2 of 5");
		expect(f?.evidence).toContain("1 after a context reset");
		expect(f?.evidence).toContain("1 mid-session");

		// Waste = Σ (write × (cacheWrite − cacheRead rate)) / 1e6 over the
		// counted turns (7k + 9k tokens).
		const cost = catalogCost();
		if (!cost) throw new Error("catalog fixture lost its rate card");
		const expected =
			((7_000 + 9_000) * (cost.cacheWrite - cost.cacheRead)) / 1_000_000;
		expect(f?.wasteUsd).toBeCloseTo(expected, 10);
		expect(f?.evidence).toContain(formatUsd(expected));
	});

	it("escalates to critical when mid-session spikes dominate the Session's turns", () => {
		// t0 excluded; t1–t3 all re-write a growing prefix (spikes);
		// 3 of 5 ≥ 50% → critical.
		seedCacheTurn("burn-cache-spike", 0, 10_000, 10_000);
		seedCacheTurn("burn-cache-spike", 1, 11_000, 11_000);
		seedCacheTurn("burn-cache-spike", 2, 12_000, 12_000);
		seedCacheTurn("burn-cache-spike", 3, 13_000, 13_000);
		seedCacheTurn("burn-cache-spike", 4, 14_000, 2_000);

		const findings = findingsSince(SINCE, "burn-cache-spike");
		expect(findings).toHaveLength(1);
		expect(findings[0]?.severity).toBe("critical");
		expect(findings[0]?.evidence).toContain("3 mid-session");
	});

	it("stays silent below two counted turns — a lone re-write is not a tax", () => {
		// First turn only (excluded) + one post-reset re-write = 1 counted:
		// t1 grows warm, t2 re-writes after the reset, t3 grows warm again.
		seedCacheTurn("burn-cache-quiet", 0, 10_000, 10_000);
		seedCacheTurn("burn-cache-quiet", 1, 30_000, 3_000);
		seedCacheTurn("burn-cache-quiet", 2, 12_000, 12_000);
		seedCacheTurn("burn-cache-quiet", 3, 14_000, 3_000);
		// Warm session entirely.
		seedCacheTurn("burn-cache-warm", 0, 10_000, 10_000);
		seedCacheTurn("burn-cache-warm", 1, 12_000, 2_000);
		seedCacheTurn("burn-cache-warm", 2, 14_000, 2_000);

		expect(findingsSince(SINCE, "burn-cache-quiet", "burn-cache-warm")).toEqual(
			[],
		);
	});

	it("omits the $ figure when the re-written turns sit on an unpriced model", () => {
		getDb()
			.insert(customProvidersTable)
			.values({
				id: "burncachebox",
				name: "Burn Cache Box",
				baseUrl: "http://localhost:2",
				api: "openai-completions",
				modelsJson: JSON.stringify([{ id: "ghost-c" }]),
			})
			.run();
		primeCustomProviders();

		seedCacheTurn("burn-cache-unpriced", 0, 10_000, 10_000, {
			provider: "burncachebox",
			model: "ghost-c",
		});
		seedCacheTurn("burn-cache-unpriced", 1, 12_000, 2_000, {
			provider: "burncachebox",
			model: "ghost-c",
		});
		seedCacheTurn("burn-cache-unpriced", 2, 7_000, 7_000, {
			provider: "burncachebox",
			model: "ghost-c",
		});
		seedCacheTurn("burn-cache-unpriced", 3, 8_000, 8_000, {
			provider: "burncachebox",
			model: "ghost-c",
		});

		const findings = findingsSince(SINCE, "burn-cache-unpriced");
		expect(findings).toHaveLength(1);
		expect(findings[0]?.wasteUsd).toBeNull();
		expect(findings[0]?.evidence).toContain("no price in the catalog");
	});
});

describe("getBurnFindings (finding M — model overthinking)", () => {
	const SINCE = 2_099_999_999;
	afterAll(() => wipeBurnFixtures("burn-think-"));

	/** One turn generating `output` tokens of which `reasoning` are
	 * thinking, at consecutive seconds so ordering is stable. */
	function seedThinkTurn(
		sessionId: string,
		i: number,
		output: number,
		reasoning: number,
		overrides: Partial<Parameters<typeof seedTurn>[0]> = {},
	) {
		seedTurn({
			id: `${sessionId}-m${i}`,
			sessionId,
			outputTokens: output,
			reasoningTokens: reasoning,
			createdAt: 2_100_000_000 + i,
			...overrides,
		});
	}

	it("fires when the median turn thinks more than it answers, waste at the output rate", () => {
		// Three turns at 60% reasoning: median 0.6 ≥ 0.5 → warning.
		seedThinkTurn("burn-think-warn", 0, 1_000, 600);
		seedThinkTurn("burn-think-warn", 1, 2_000, 1_200);
		seedThinkTurn("burn-think-warn", 2, 3_000, 1_800);

		const findings = findingsSince(SINCE, "burn-think-warn");
		expect(findings).toHaveLength(1);
		const f = findings[0];
		expect(f?.check).toBe("model-overthinking");
		expect(f?.severity).toBe("warning");
		expect(f?.evidence).toContain("60%");
		expect(f?.evidence).toContain("3 of 3");

		const cost = catalogCost();
		if (!cost) throw new Error("catalog fixture lost its rate card");
		const expected = (3_600 * cost.output) / 1_000_000;
		expect(f?.wasteUsd).toBeCloseTo(expected, 10);
		expect(f?.evidence).toContain(formatUsd(expected));
	});

	it("escalates to critical past the 75% median", () => {
		seedThinkTurn("burn-think-crit", 0, 1_000, 800);
		seedThinkTurn("burn-think-crit", 1, 1_000, 800);
		seedThinkTurn("burn-think-crit", 2, 1_000, 800);

		const findings = findingsSince(SINCE, "burn-think-crit");
		expect(findings).toHaveLength(1);
		expect(findings[0]?.severity).toBe("critical");
	});

	it("stays silent at or below the threshold and with too few comparable turns", () => {
		// Median 0.4 — under the 0.5 line.
		seedThinkTurn("burn-think-low", 0, 1_000, 400);
		seedThinkTurn("burn-think-low", 1, 1_000, 400);
		seedThinkTurn("burn-think-low", 2, 1_000, 400);
		// Two turns is a one-off, however thinky.
		seedThinkTurn("burn-think-few", 0, 1_000, 900);
		seedThinkTurn("burn-think-few", 1, 1_000, 900);

		expect(findingsSince(SINCE, "burn-think-low", "burn-think-few")).toEqual(
			[],
		);
	});

	it("omits the $ figure for an unpriced model while still firing", () => {
		getDb()
			.insert(customProvidersTable)
			.values({
				id: "burnthinkbox",
				name: "Burn Think Box",
				baseUrl: "http://localhost:3",
				api: "openai-completions",
				modelsJson: JSON.stringify([{ id: "ghost-m" }]),
			})
			.run();
		primeCustomProviders();

		seedThinkTurn("burn-think-unpriced", 0, 1_000, 800, {
			provider: "burnthinkbox",
			model: "ghost-m",
		});
		seedThinkTurn("burn-think-unpriced", 1, 1_000, 800, {
			provider: "burnthinkbox",
			model: "ghost-m",
		});
		seedThinkTurn("burn-think-unpriced", 2, 1_000, 800, {
			provider: "burnthinkbox",
			model: "ghost-m",
		});

		const findings = findingsSince(SINCE, "burn-think-unpriced");
		expect(findings).toHaveLength(1);
		expect(findings[0]?.wasteUsd).toBeNull();
		expect(findings[0]?.evidence).toContain("no price in the catalog");
	});
});

describe("getBurnFindings (finding S — expensive delegation)", () => {
	const SINCE = 2_199_999_999;
	const NOW = 2_200_000_000;
	afterAll(() => wipeBurnFixtures("burn-s-"));

	/** A scored turn's trail: the turn's last message, its `purpose="turn"`
	 * usage row, and (optionally) the judge side — a `purpose="judge"` usage
	 * row plus the `turn_scores` row `scoreTurn` writes right after it. */
	function seedJudgedTurn(opts: {
		sessionId: string;
		turnId: string;
		turnEnd: number;
		scoredCost: number;
		judgeCost?: number;
		judgeAt?: number;
		scoreAt?: number;
		withMessages?: boolean;
	}) {
		if (opts.withMessages !== false) {
			getDb()
				.insert(messagesTable)
				.values({
					id: `${opts.turnId}-msg`,
					sessionId: opts.sessionId,
					role: "assistant",
					partsJson: "[]",
					turnId: opts.turnId,
					createdAt: opts.turnEnd,
				})
				.run();
		}
		seedTurn({
			id: `${opts.sessionId}-scored-${opts.turnId}`,
			sessionId: opts.sessionId,
			createdAt: opts.turnEnd,
			costUsd: opts.scoredCost,
		});
		if (opts.judgeCost != null) {
			seedTurn({
				id: `${opts.sessionId}-judge-${opts.turnId}`,
				sessionId: opts.sessionId,
				createdAt: opts.judgeAt ?? opts.turnEnd + 1,
				costUsd: opts.judgeCost,
				purpose: "judge",
			});
			getDb()
				.insert(turnScoresTable)
				.values({
					id: `${opts.turnId}-score`,
					sessionId: opts.sessionId,
					turnId: opts.turnId,
					metric: "relevancy",
					provider: CATALOG_PROVIDER,
					model: CATALOG_MODEL,
					score: 0.9,
					threshold: 0.5,
					passed: true,
					reason: "fine",
					createdAt: opts.scoreAt ?? opts.judgeAt ?? opts.turnEnd + 1,
				})
				.run();
		}
	}

	it("flags judge calls that outspent the turn they scored, worst first (issue #294)", () => {
		seedSessionRow("burn-s-judge", { title: "Judge heavy" });
		// One turn scored by an expensive judge call: 0.05 judging a 0.01
		// turn — 5× the scored spend, exactly the critical line.
		seedJudgedTurn({
			sessionId: "burn-s-judge",
			turnId: "turn-j1",
			turnEnd: NOW,
			scoredCost: 0.01,
			judgeCost: 0.05,
		});

		const findings = findingsSince(SINCE, "burn-s-judge");
		expect(findings).toHaveLength(1);
		const f = findings[0];
		expect(f?.check).toBe("expensive-delegation");
		expect(f?.title).toBe("Judge heavy");
		// 5× is exactly the critical ratio.
		expect(f?.severity).toBe("critical");
		expect(f?.wasteUsd).toBeCloseTo(0.04, 10);
		expect(f?.evidence).toContain("1 of 1 judge calls");
		expect(f?.evidence).toContain("$0.05");
		expect(f?.evidence).toContain("$0.01");
		expect(f?.evidence).toContain("5×");
	});

	it("aggregates calls per Session and ignores judges that came in cheaper", () => {
		seedSessionRow("burn-s-mixed", { title: "Mixed judging" });
		// 0.06 judging a 0.02 turn (3×, warning territory)…
		seedJudgedTurn({
			sessionId: "burn-s-mixed",
			turnId: "turn-m1",
			turnEnd: NOW,
			scoredCost: 0.02,
			judgeCost: 0.06,
		});
		// …and a second call that cost less than its turn: not an overspend.
		seedJudgedTurn({
			sessionId: "burn-s-mixed",
			turnId: "turn-m2",
			turnEnd: NOW + 100,
			scoredCost: 0.02,
			judgeCost: 0.005,
		});

		const findings = findingsSince(SINCE, "burn-s-mixed");
		expect(findings).toHaveLength(1);
		const f = findings[0];
		expect(f?.severity).toBe("warning");
		// Only the overspending pair is wasted; the cheaper call still counts
		// as compared.
		expect(f?.wasteUsd).toBeCloseTo(0.04, 10);
		expect(f?.evidence).toContain("1 of 2 judge calls");
	});

	it("drops unpairable calls — no score nearby, or a deleted Session's messages — instead of guessing", () => {
		seedSessionRow("burn-s-orphan", { title: "Orphan judges" });
		// Judge call with no turn_scores row within the pair window.
		seedJudgedTurn({
			sessionId: "burn-s-orphan",
			turnId: "turn-o1",
			turnEnd: NOW,
			scoredCost: 0.01,
		});
		seedTurn({
			id: "burn-s-orphan-lone-judge",
			sessionId: "burn-s-orphan",
			createdAt: NOW + 10,
			costUsd: 0.5,
			purpose: "judge",
		});
		// Judge + score pair whose Session was deleted (no messages row, so
		// the scored turn's end is unknowable).
		seedJudgedTurn({
			sessionId: "burn-s-orphan",
			turnId: "turn-o2",
			turnEnd: NOW + 200,
			scoredCost: 0.01,
			judgeCost: 0.4,
			withMessages: false,
		});

		// The in-range turn rows (the 0.01 scored turns) are real spend but
		// unflaggable — no pair survives attribution.
		expect(findingsSince(SINCE, "burn-s-orphan")).toEqual([]);
	});

	it("flags an orchestrator whose fan-out dwarfs its own spend, naming the largest child", () => {
		seedSessionRow("burn-s-orch", { title: "The orchestrator" });
		seedTurn({
			id: "burn-s-orch-own",
			sessionId: "burn-s-orch",
			createdAt: NOW,
			costUsd: 0.01,
		});
		seedSessionRow("burn-s-child-a", { title: "Child A" });
		getDb()
			.update(sessionsTable)
			.set({ spawnedBy: "burn-s-orch" })
			.where(eq(sessionsTable.id, "burn-s-child-a"))
			.run();
		seedTurn({
			id: "burn-s-child-a-turn",
			sessionId: "burn-s-child-a",
			createdAt: NOW,
			costUsd: 0.03,
		});
		seedSessionRow("burn-s-child-b", { title: "Child B" });
		getDb()
			.update(sessionsTable)
			.set({ spawnedBy: "burn-s-orch" })
			.where(eq(sessionsTable.id, "burn-s-child-b"))
			.run();
		seedTurn({
			id: "burn-s-child-b-turn",
			sessionId: "burn-s-child-b",
			createdAt: NOW,
			costUsd: 0.1,
		});

		const findings = findingsSince(SINCE, "burn-s-orch");
		expect(findings).toHaveLength(1);
		const f = findings[0];
		expect(f?.check).toBe("expensive-delegation");
		expect(f?.title).toBe("The orchestrator");
		// 13× the orchestrator's own spend: warning (critical is 25×).
		expect(f?.severity).toBe("warning");
		// Fan-out spend is real work, not waste — no $ figure.
		expect(f?.wasteUsd).toBeNull();
		expect(f?.evidence).toContain("2 child Sessions");
		expect(f?.evidence).toContain("$0.13");
		expect(f?.evidence).toContain("13×");
		expect(f?.evidence).toContain("Child B");
		// The documented attribution gap (ADR-0034 subagents) is stated on
		// the finding, never silently absorbed.
		expect(f?.evidence).toContain("subagent");
	});

	it("escalates a 25×+ fan-out to critical and stays silent below 5×", () => {
		seedSessionRow("burn-s-orch-crit", { title: "Critical fan" });
		seedTurn({
			id: "burn-s-orch-crit-own",
			sessionId: "burn-s-orch-crit",
			createdAt: NOW,
			costUsd: 0.01,
		});
		seedSessionRow("burn-s-child-crit");
		getDb()
			.update(sessionsTable)
			.set({ spawnedBy: "burn-s-orch-crit" })
			.where(eq(sessionsTable.id, "burn-s-child-crit"))
			.run();
		seedTurn({
			id: "burn-s-child-crit-turn",
			sessionId: "burn-s-child-crit",
			createdAt: NOW,
			costUsd: 0.3,
		});

		// Healthy delegation: children cost less than 5× the orchestrator.
		seedSessionRow("burn-s-orch-ok", { title: "Balanced" });
		seedTurn({
			id: "burn-s-orch-ok-own",
			sessionId: "burn-s-orch-ok",
			createdAt: NOW,
			costUsd: 0.1,
		});
		seedSessionRow("burn-s-child-ok");
		getDb()
			.update(sessionsTable)
			.set({ spawnedBy: "burn-s-orch-ok" })
			.where(eq(sessionsTable.id, "burn-s-child-ok"))
			.run();
		seedTurn({
			id: "burn-s-child-ok-turn",
			sessionId: "burn-s-child-ok",
			createdAt: NOW,
			costUsd: 0.2,
		});

		const findings = findingsSince(SINCE, "burn-s-orch-crit", "burn-s-orch-ok");
		expect(findings).toHaveLength(1);
		expect(findings[0]?.sessionId).toBe("burn-s-orch-crit");
		expect(findings[0]?.severity).toBe("critical");
	});

	it("fires on an orchestrator with expensive children but no in-range spend of its own", () => {
		seedSessionRow("burn-s-orch-idle", { title: "Idle delegator" });
		seedSessionRow("burn-s-child-idle");
		getDb()
			.update(sessionsTable)
			.set({ spawnedBy: "burn-s-orch-idle" })
			.where(eq(sessionsTable.id, "burn-s-child-idle"))
			.run();
		seedTurn({
			id: "burn-s-child-idle-turn",
			sessionId: "burn-s-child-idle",
			createdAt: NOW,
			costUsd: 0.5,
		});

		const findings = findingsSince(SINCE, "burn-s-orch-idle");
		expect(findings).toHaveLength(1);
		expect(findings[0]?.wasteUsd).toBeNull();
		expect(findings[0]?.evidence).toContain("recorded no spend");
	});
});
