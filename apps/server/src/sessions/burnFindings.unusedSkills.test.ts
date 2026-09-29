import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TurnToolFacts } from "@dilna/shared";
import { formatUsd } from "@dilna/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveSummarizationModel } from "../agents/pi";
import { LIBRARY_CHARS_PER_TOKEN } from "../agents/providerConfig";
import { closeDb, getDb } from "../db";
import {
	repoSkills as repoSkillsTable,
	sessions as sessionsTable,
	skills as skillsTable,
	usageEvents as usageEventsTable,
} from "../db/schema";
import { getEnabledSkillDirs, setSkillEnabled } from "../skills/store";
import { getUsageSummary } from "./usageStats";

let dataDir: string;
let oldDataDir: string | undefined;

beforeAll(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-burn-skills-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;
});

afterAll(() => {
	closeDb();
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
});

// claude-haiku-4-5: in the catalog, priced — the dominant model whose input
// rate the waste estimate borrows in the priced case.
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

/** Insert a live `sessions` row — `createdAt` matters for finding K's carry
 * test (ADR-0049 freezes the prompt at Session start). */
function seedSessionRow(
	id: string,
	{ repoId, createdAt }: { repoId?: string; createdAt?: number } = {},
) {
	getDb()
		.insert(sessionsTable)
		.values({
			id,
			repoId: repoId ?? "repo-burn",
			worktreePath: `/tmp/${id}`,
			worktreeDirName: id,
			branchName: `${id}-branch`,
			title: `Session ${id}`,
			...(createdAt != null ? { createdAt } : {}),
		})
		.run();
}

describe("getBurnFindings (finding K — unused skills, issue #295)", () => {
	const DAY = 86_400;
	const now = () => Math.floor(Date.now() / 1000);

	/** Seed a skill catalog row + a Repo→skill enablement (the storage model
	 * finding K reads; install-from-network is registry.test.ts's business). */
	function seedSkill(id: string, name: string, description: string) {
		getDb()
			.insert(skillsTable)
			.values({
				id,
				source: id.split("/").slice(0, 2).join("/"),
				slug: id.split("/").at(-1) ?? id,
				name,
				description,
				sourceUrl: `https://github.com/${id.split("/").slice(0, 2).join("/")}`,
			})
			.onConflictDoNothing()
			.run();
	}

	function enableForRepo(skillId: string, repoId: string, enabledAt: number) {
		getDb()
			.insert(repoSkillsTable)
			.values({ skillId, repoId, enabledAt })
			.onConflictDoNothing()
			.run();
	}

	/** Fact-carrying turns (no sessions row — the row's own createdAt stands
	 * in for the session start, which keeps these sessions "started now"). */
	function seedFactTurns(
		repoId: string,
		prefix: string,
		count: number,
		skillsOf: (i: number) => Record<string, number> = () => ({}),
		sessionIdOf: (i: number) => string = (i) => `${prefix}-sess-${i % 3}`,
	) {
		for (let i = 0; i < count; i++) {
			seedTurn({
				id: `${prefix}-${i}`,
				sessionId: sessionIdOf(i),
				repoId,
				toolFacts: { tools: { bash: 1 }, skills: skillsOf(i) },
			});
		}
	}

	const unusedSkillFindings = (repoId: string) =>
		getUsageSummary(0).burnFindings.filter(
			(f) => f.check === "repo-unused-skill" && f.repoId === repoId,
		);

	it("fires for a skill enabled but never loaded in range, with waste and the disable action", () => {
		seedSkill(
			"acme/skills/never",
			"never",
			"Test-driven development guidance.",
		);
		enableForRepo("acme/skills/never", "repo-k-never", now() - DAY);
		seedFactTurns("repo-k-never", "k-never", 10);

		const findings = unusedSkillFindings("repo-k-never");
		expect(findings).toHaveLength(1);
		const finding = findings[0];
		expect(finding?.sessionId).toBeNull();
		expect(finding?.title).toBe("never");
		expect(finding?.severity).toBe("info");
		expect(finding?.action).toEqual({
			kind: "disable-skill-for-repo",
			skillId: "acme/skills/never",
			skillName: "never",
		});

		// Waste = the prompt line's tokens × carrying turns × the dominant
		// (here: only) model's catalog input rate — computed against the same
		// resolver the finding uses, so the test pins the shape, not a price.
		const model = resolveSummarizationModel(CATALOG_PROVIDER, CATALOG_MODEL);
		expect(model).toBeDefined();
		const rate = model?.cost.input ?? 0;
		const descTokens = Math.ceil(
			"- never: Test-driven development guidance.".length /
				LIBRARY_CHARS_PER_TOKEN,
		);
		const waste = (descTokens * 10 * rate) / 1_000_000;
		expect(finding?.wasteUsd).toBeCloseTo(waste, 10);
		expect(finding?.evidence).toContain("10 turns of Sessions started");
		expect(finding?.evidence).toContain(
			`${CATALOG_PROVIDER}/${CATALOG_MODEL}'s uncached input rate`,
		);
		expect(finding?.evidence).toContain(`≈ ${formatUsd(waste)}`);
	});

	it("produces no finding for a skill loaded at least once in the range (rarely-used boundary)", () => {
		seedSkill("acme/skills/once", "once", "Used a single time.");
		enableForRepo("acme/skills/once", "repo-k-once", now() - DAY);
		seedFactTurns(
			"repo-k-once",
			"k-once",
			10,
			(i): Record<string, number> => (i === 4 ? { once: 1 } : {}),
		);

		expect(unusedSkillFindings("repo-k-once")).toEqual([]);
	});

	it("never reads a thin or absent fact set as evidence of disuse", () => {
		// Pre-feature turns only: the repo has plenty of turns, but none carry
		// facts, so "never loaded" is unknowable — no verdict.
		seedSkill("acme/skills/prefeat", "prefeat", "Installed before facts.");
		enableForRepo("acme/skills/prefeat", "repo-k-prefeat", now() - 7 * DAY);
		for (let i = 0; i < 12; i++) {
			seedTurn({ id: `k-prefeat-${i}`, sessionId: `k-prefeat-s-${i}` });
		}
		expect(unusedSkillFindings("repo-k-prefeat")).toEqual([]);

		// One turn below the observation window: also no verdict, while the
		// control repo at exactly MIN_FACT_TURNS does fire.
		seedSkill("acme/skills/thin", "thin", "Barely observed.");
		enableForRepo("acme/skills/thin", "repo-k-thin", now() - DAY);
		seedFactTurns("repo-k-thin", "k-thin", 9);
		expect(unusedSkillFindings("repo-k-thin")).toEqual([]);
	});

	it("counts only turns of Sessions started while the skill was enabled (frozen prompt)", () => {
		seedSkill("acme/skills/late", "late", "Enabled after these Sessions.");
		const enabledAt = now() - DAY;
		enableForRepo("acme/skills/late", "repo-k-freeze", enabledAt);
		// Ten fact-carrying turns on Sessions created long before the skill
		// was enabled: their frozen system prompts never carried it.
		const oldStart = now() - 10 * DAY;
		for (const sid of ["k-freeze-s0", "k-freeze-s1"]) {
			seedSessionRow(sid, { repoId: "repo-k-freeze", createdAt: oldStart });
		}
		seedFactTurns(
			"repo-k-freeze",
			"k-freeze",
			10,
			() => ({}),
			(i) => `k-freeze-s${i % 2}`,
		);
		expect(unusedSkillFindings("repo-k-freeze")).toEqual([]);

		// Mixed: the same enablement on another repo plus ten turns on
		// Sessions started after it — exactly the window the finding counts
		// (10, not 20: only Sessions that actually carried the skill count).
		enableForRepo("acme/skills/late", "repo-k-mixed", enabledAt);
		seedFactTurns("repo-k-mixed", "k-mixed", 10);
		const findings = unusedSkillFindings("repo-k-mixed");
		expect(findings).toHaveLength(1);
		expect(findings[0]?.evidence).toContain("10 turns of Sessions started");
	});

	it("never counts judge rows as loads or as observation (purpose is structural)", () => {
		seedSkill(
			"acme/skills/kjudge",
			"kjudge",
			"Scoring-side reads don't count.",
		);
		enableForRepo("acme/skills/kjudge", "repo-k-judge", now() - DAY);
		// Judge rows claim a load of the skill; the ten real turns don't.
		// If judge facts leaked into the load set, the finding would be
		// wrongly suppressed; leaked into the window, it would fire early.
		for (let i = 0; i < 10; i++) {
			seedTurn({
				id: `k-judge-j-${i}`,
				sessionId: `k-judge-j-${i}`,
				repoId: "repo-k-judge",
				purpose: "judge",
				toolFacts: { tools: {}, skills: { kjudge: 1 } },
			});
		}
		seedFactTurns("repo-k-judge", "k-judge-turns", 10);

		expect(unusedSkillFindings("repo-k-judge")).toHaveLength(1);
	});

	it("loads recorded on another Repo don't suppress this Repo's finding", () => {
		seedSkill("acme/skills/shared", "shared", "Used elsewhere, not here.");
		enableForRepo("acme/skills/shared", "repo-k-here", now() - DAY);
		enableForRepo("acme/skills/shared", "repo-k-there", now() - DAY);
		seedFactTurns(
			"repo-k-there",
			"k-there",
			10,
			(i): Record<string, number> => (i === 0 ? { shared: 1 } : {}),
		);
		seedFactTurns("repo-k-here", "k-here", 10);

		expect(unusedSkillFindings("repo-k-there")).toEqual([]);
		expect(unusedSkillFindings("repo-k-here")).toHaveLength(1);
	});

	it("ships without a $ figure when no model in range has a catalog price", () => {
		seedSkill("acme/skills/ghost", "ghost", "Runs on unpriced models.");
		enableForRepo("acme/skills/ghost", "repo-k-ghost", now() - DAY);
		for (let i = 0; i < 10; i++) {
			seedTurn({
				id: `k-ghost-${i}`,
				sessionId: `k-ghost-s-${i}`,
				repoId: "repo-k-ghost",
				provider: "nocatalog",
				model: "ghost-9",
				toolFacts: { tools: {}, skills: {} },
			});
		}

		const findings = unusedSkillFindings("repo-k-ghost");
		expect(findings).toHaveLength(1);
		expect(findings[0]?.wasteUsd).toBeNull();
		expect(findings[0]?.evidence).toContain("no price in the catalog");
		expect(findings[0]?.evidence).not.toContain("$");
	});

	it("clears once the skill is disabled for the Repo, which also stops the prompt carry", async () => {
		seedSkill("acme/skills/clear", "clear", "Will be disabled.");
		enableForRepo("acme/skills/clear", "repo-k-clear", now() - DAY);
		seedFactTurns("repo-k-clear", "k-clear", 10);
		expect(unusedSkillFindings("repo-k-clear")).toHaveLength(1);

		// The action's effect — the same `setSkillEnabled` the route calls —
		// removes the enablement row, so Sessions started afterwards no
		// longer load the skill (nothing to hand the prompt builder) and the
		// finding has nothing left to be about.
		await setSkillEnabled("acme/skills/clear", "repo-k-clear", false);
		const dirs = await getEnabledSkillDirs("repo-k-clear");
		expect(dirs.some((dir) => dir.includes("acme/skills/clear"))).toBe(false);
		expect(unusedSkillFindings("repo-k-clear")).toEqual([]);
	});

	it("ranks by estimated waste across checks: a small info finding never outranks costlier ones", () => {
		seedSkill("acme/skills/rank", "rank", "Cheap noise.");
		enableForRepo("acme/skills/rank", "repo-k-rank", now() - DAY);
		seedFactTurns("repo-k-rank", "k-rank", 10);
		seedDeepSession("k-rank-overdepth", [0.9, 0.9, 0.9], [0.5, 0.4, 0.1]);

		const findings = getUsageSummary(0).burnFindings;
		expect(findings[0]?.check).toBe("session-overdepth");
		// The deep Session's $0.10 premium outranks every unused-skill
		// estimate (fractions of a cent) — the union is one worst-first list.
		const skillIdx = findings.findIndex((f) => f.check === "repo-unused-skill");
		const overdepthIdx = findings.findIndex(
			(f) =>
				f.check === "session-overdepth" && f.sessionId === "k-rank-overdepth",
		);
		expect(skillIdx).toBeGreaterThan(-1);
		expect(overdepthIdx).toBeGreaterThan(-1);
		expect(overdepthIdx).toBeLessThan(skillIdx);
	});
});
