import type { BurnFinding, BurnFindingAction, ToolName } from "@dilna/shared";
import { formatTokenCount, formatUsd, TOOL_NAMES } from "@dilna/shared";
import {
	and,
	asc,
	between,
	eq,
	gte,
	inArray,
	isNotNull,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import { resolveSummarizationModel } from "../agents/pi";
import { LIBRARY_CHARS_PER_TOKEN } from "../agents/providerConfig";
import {
	TOOL_BURN_CLASSIFICATION,
	toolSchemaTokens,
} from "../agents/toolSchemaWeight";
import { getDb } from "../db";
import {
	messages as messagesTable,
	repoSkills as repoSkillsTable,
	sessionArchive as sessionArchiveTable,
	sessions as sessionsTable,
	skills as skillsTable,
	turnScores as turnScoresTable,
	usageEvents as usageEventsTable,
} from "../db/schema";
import { resolveSessionTitles } from "./usageStats";

/**
 * Burn findings (issue #291, ADR-0051) — the judgment layer over the spend
 * `usageStats.ts` measures. Each check turns raw `usage_events` rows (plus,
 * where relevant, the Session's compaction/spawn-lineage fields) into a
 * `BurnFinding`: a severity, human-readable evidence, and an estimated $
 * waste. Everything is computed here, in one place, over the same time range
 * as the usage summary — the web renders the shared `BurnFinding` shape
 * verbatim and computes nothing (same single-home policy as `cacheHitRate`).
 *
 * The ticket batch's letters map to check codes (ADR-0051): D =
 * `session-overdepth` (#291), C = `cache-rehydration`, M =
 * `model-overthinking`, S = `expensive-delegation` (#294), K =
 * `repo-unused-skill` (#295), T = `unused-tool` (#296).
 *
 * Pricing follows the empty-slice rule the rest of the summary already uses:
 * a Model with no price in the catalog (custom-provider models are built
 * with an all-zero cost, and out-of-catalog ids resolve to nothing) yields a
 * finding *without* a $ figure (`wasteUsd: null`) — never a computed 0,
 * which would read as "free" rather than "unmeasurable". The poison is
 * scoped to what each waste model actually reads: D's premium is relative to
 * a baseline built from *every* turn, so any unpriced turn downgrades the
 * whole finding, while C's and M's waste is an absolute (rate × tokens) sum
 * over the flagged turns alone, so only those turns need a price.
 */
/** Median reported context occupancy past which a Session's depth is
 * flagged: a Session whose *median* turn sits at or beyond this share of its
 * model's window is paying the depth premium (prompt-side tokens scale with
 * occupancy) on most of its turns. Well below where compaction fires
 * (`contextWindow - reserveTokens`, ~92% of a 200k window), so this flags
 * depth while there is still room to do something about it. */
export const OVERDEPTH_THRESHOLD = 0.7;

/** Median occupancy past which the finding escalates to critical — at this
 * depth compaction is either firing or imminent, so every turn also pays the
 * post-compaction cache re-write on top. */
export const OVERDEPTH_CRITICAL_THRESHOLD = 0.85;

/** Smallest number of provider-reported turns a depth verdict may rest on —
 * one deep turn is a one-off (a big paste, a long read), not a Session
 * sitting deep. Same "a verdict on one turn is noise" reasoning as the
 * drift list's `turns` field. Shared by the overthinking check, whose
 * median-turn share verdict rests on the same noise argument. */
const MIN_REPORTED_TURNS = 3;

/** Share of a turn's prompt prefix that must land as cache writes for the
 * turn to count as a *rehydration* — the whole context written fresh. A warm
 * turn re-reads most of its prefix at the (roughly 10× cheaper) cache-read
 * rate and writes only the new tail; a turn that pays the write rate on
 * four-fifths of its prefix didn't hit the cache at all, whether because the
 * prefix broke (frozen system prompt mismatch, a changed tool set) or
 * because a re-seed just replaced it wholesale. */
export const REHYDRATION_SHARE = 0.8;

/** How far the prompt prefix must shrink between two consecutive reported
 * turns for the rehydration after it to count as *post-reset*: only a
 * re-seed — a compaction (ADR-0023) or a tool-output trim (#272) — shrinks
 * context mid-session, and both replace the prefix wholesale, so history
 * otherwise only ever grows. A drop of a third is far beyond turn-to-turn
 * noise and far below what compaction at depth actually sheds. */
export const REHYDRATION_RESET_FACTOR = 1.5;

/** Smallest number of counted rehydration turns (post-reset re-writes plus
 * mid-session spikes) a cache finding may rest on. One is never a finding:
 * the Session's first reported turn re-writes its prefix *by definition*
 * (nothing is cached yet), and a lone post-reset re-write is compaction
 * doing its job — persistence is what makes the tax worth naming. */
export const MIN_REHYDRATION_TURNS = 2;

/** Share of reported turns that must be mid-session spikes (a *growing*
 * prefix re-written whole) before the cache finding escalates to critical —
 * at that rate the cache is broken more often than it works, and every turn
 * is paying full freight. */
export const REHYDRATION_CRITICAL_SHARE = 0.5;

/** Median reasoning share of generated output past which a Session is
 * flagged for overthinking. Reasoning tokens bill at the model's plain
 * output rate, so a Session that spends half its generation on thinking is
 * paying roughly double for the same answers. The issue phrases this as a
 * share of *spend*; the token share is the always-computable form of the
 * same ratio (the $ share would need splitting the provider's blended
 * `costUsd`, which is unavailable exactly when the model is unpriced — and
 * reasoning cost is proportional to reasoning tokens at a fixed rate, so the
 * two track each other). */
export const OVERTHINK_THRESHOLD = 0.5;

/** Median reasoning share past which overthinking escalates to critical —
 * three quarters of everything the Session generates is thinking. */
export const OVERTHINK_CRITICAL_THRESHOLD = 0.75;

/** Ratio of child-Session spend to the orchestrator's own spend past which
 * the fan-out is flagged as expensive. Some ratio is healthy — cheap
 * coordination producing real work is the point of the orchestrator
 * (ADR-0021) — but an order of magnitude beyond the orchestrator's own
 * budget is delegation cost the user should see before the bill does. */
export const FANOUT_RATIO = 5;

/** Fan-out ratio past which the finding escalates to critical. */
export const FANOUT_CRITICAL_RATIO = 25;

/** Ratio past which a single judge call's cost escalates the judge finding
 * to critical — a judge spending 5× the turn it scored is evaluating the
 * work more expensively than doing it. */
export const JUDGE_CRITICAL_RATIO = 5;

/** How many seconds after a judge call's `usage_events` row its
 * `turn_scores` row may land and still be paired with it. `scoreTurn`
 * records the run's usage in a `finally` and inserts the score row
 * immediately after — microseconds apart, same second in practice; the
 * window only absorbs clock jitter. Scores older than their judge row (a
 * previous run's) are never paired. */
const JUDGE_PAIR_WINDOW_S = 60;

/** How far (in seconds) a scored turn's `usage_events` row may sit from the
 * turn's last `messages` row and still count as that turn's spend row. The
 * row is written on the turn-end event, right after the final assistant
 * round is persisted — same second in practice. Matches outside the window
 * are dropped (the pair is not compared) rather than guessed. */
const TURN_MATCH_WINDOW_S = 5;

/** Smallest number of observed turns an unused-skill verdict may rest on:
 * turns of Sessions that actually carried the skill (started while it was
 * enabled) and recorded tool/skill facts. This is the check's minimum
 * observation window, and it is what keeps the forward-only fact capture
 * honest — "no read_skill facts yet" (facts only exist for turns after
 * issue #292 shipped) must never read as "the skill was never read". Ten
 * turns is enough relevant-task opportunities to distinguish "never
 * relevant" from "hasn't come up yet" while staying small enough that a
 * genuinely dead skill surfaces within the default 7d range. */
export const MIN_FACT_TURNS = 10;

/** How many findings the Burn checks card shows, worst first — same cap
 * shape as the top-spend and drift lists. */
const BURN_FINDINGS_LIMIT = 10;

const SEVERITY_RANK = { critical: 2, warning: 1, info: 0 } as const;

/** Smallest number of fact-stamped turns (issue #292's `tool_facts_json`)
 * finding T's verdict may rest on. Tool-usage facts are forward-only — turns
 * from before #292 shipped carry no facts at all — so absence of usage data
 * is never read as proof a tool is unused: the window only counts turns that
 * actually recorded what they did, and there must be enough of them that
 * "never called" means something. 25 turns is a few work Sessions; below
 * that, the honest verdict is "not observed yet", not a finding. (K's
 * `MIN_FACT_TURNS` above is deliberately smaller — its window is per-Repo
 * and only turns of Sessions that *carried* the skill, a far denser signal
 * than T's instance-wide any-ordinary-turn count.) */
export const MIN_TOOL_OBSERVATION_TURNS = 25;

/** Usage rate below which a tool that *was* called still counts as barely
 * used (finding T): fewer than one call per ~50 observed turns means the
 * calls it did make never came close to justifying a schema riding in every
 * single turn. A tool at or above this line earned its keep often enough
 * that the disable question is a judgment call, not a finding. */
export const RARE_TOOL_RATE = 0.02;

/** One turn row, narrowed to what the checks read. */
type TurnRow = {
	repoId: string;
	provider: string;
	model: string;
	costUsd: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	reasoningTokens: number;
	providerContextTokens: number | null;
	createdAt: number;
};

/** One judge-call row (ADR-0046), narrowed to what finding S reads. */
type JudgeRow = {
	repoId: string;
	provider: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	createdAt: number;
};

/** One Session's turn rows in range, oldest last. */
type SessionTurns = {
	sessionId: string;
	repoId: string;
	rows: TurnRow[];
};

/** A turn row with its catalog Model resolved once — the window drives the
 * depth, the rate card drives pricing, and every check reads both, so the
 * lookup happens once per row instead of once per check. */
type ResolvedTurn = TurnRow & {
	/** The catalog Model behind the row's provider/model id — the window
	 * and rate card every priced figure comes from. Undefined when the id
	 * is out of catalog. Named apart from `TurnRow.model` (the id string). */
	catalog: ReturnType<typeof resolveSummarizationModel>;
	/** Catalog window of the resolved Model; 0 when out of catalog. */
	window: number;
	/** `providerContextTokens / window`, when both are positive — the depth
	 * finding D judges. Null for rows predating the provider stamp or whose
	 * model left the catalog; never treated as zero. */
	depth: number | null;
	/** The prompt-side portion of the reported context — everything the
	 * provider read or wrote before this turn's own output. Null when the
	 * row carries no provider report. This is what a cache re-write
	 * re-writes, so it is the denominator of the rehydration share. */
	prefixTokens: number | null;
	/** Whether the catalog prices this model at all (the empty-slice rule's
	 * trigger). Custom-provider models are built with an all-zero cost. */
	priced: boolean;
};

/** Internal finding-D verdict for one Session, before titles/compaction are
 * resolved onto the shared shape. */
type OverdepthCandidate = {
	check: "session-overdepth";
	sessionId: string;
	repoId: string;
	severity: "warning" | "critical";
	medianDepth: number;
	maxDepth: number;
	deepTurns: number;
	reportedTurns: number;
	windowTokens: number;
	/** Null when any of the Session's turn rows sits on an unpriced or
	 * out-of-catalog model — the $ figure would be invented (module doc's
	 * empty-slice rule), so the finding ships without one. */
	wasteUsd: number | null;
};

/** Internal finding-C verdict for one Session. */
type CacheCandidate = {
	check: "cache-rehydration";
	sessionId: string;
	repoId: string;
	severity: "info" | "warning" | "critical";
	/** Rehydration turns counted toward the tax: post-reset re-writes plus
	 * mid-session spikes. The Session's first reported turn is excluded —
	 * every Session re-writes its prefix once by definition. */
	taxTurns: number;
	resetTurns: number;
	spikeTurns: number;
	reportedTurns: number;
	/** Median cache-write volume of the counted turns — the size of the
	 * re-written prefix. */
	medianRewriteTokens: number;
	/** Null when any counted turn sits on an unpriced or out-of-catalog
	 * model: the premium is (write rate − read rate) × tokens on those turns
	 * alone, so only they can poison it (module doc). */
	wasteUsd: number | null;
};

/** Internal finding-M verdict for one Session. */
type ThinkCandidate = {
	check: "model-overthinking";
	sessionId: string;
	repoId: string;
	severity: "warning" | "critical";
	medianShare: number;
	peakShare: number;
	flaggedTurns: number;
	reportedTurns: number;
	/** Null when any flagged turn sits on an unpriced or out-of-catalog
	 * model — the waste is the flagged reasoning at the output rate, so only
	 * flagged turns can poison it (module doc). */
	wasteUsd: number | null;
};

/** Internal finding-S verdict, fan-out shape: one orchestrator Session's
 * delegation bill. */
type FanoutCandidate = {
	check: "expensive-delegation";
	kind: "fanout";
	sessionId: string;
	repoId: string | null;
	severity: "warning" | "critical";
	children: number;
	childSpend: number;
	ownSpend: number;
	/** Null when the orchestrator's own in-range spend is zero — there is no
	 * ratio against nothing. */
	ratio: number | null;
	/** Largest child by in-range spend — named in the evidence, its title
	 * resolved in the same batch as every candidate Session's. */
	topChildId: string | null;
	topChildSpend: number;
	/** Always null: the fan-out total is real spend on real work, not waste
	 * — no counterfactual "cheaper delegation" exists to price it against.
	 * The evidence carries the total instead. */
	wasteUsd: null;
};

/** Internal finding-S verdict, judge shape: one Session's judging that
 * outspends the turns it scored. */
type JudgeCandidate = {
	check: "expensive-delegation";
	kind: "judge";
	sessionId: string;
	repoId: string;
	severity: "warning" | "critical";
	compared: number;
	overspending: number;
	judgeTokens: number;
	judgeSpend: number;
	scoredSpend: number;
	worstJudgeCost: number;
	worstScoredCost: number;
	/** Never null: the figures are recorded `costUsd` values, not catalog
	 * derivations — the judge-vs-scored comparison is priceable wherever it
	 * is computable at all. */
	wasteUsd: number;
};

type Candidate =
	| OverdepthCandidate
	| CacheCandidate
	| ThinkCandidate
	| FanoutCandidate
	| JudgeCandidate;

/**
 * Burn findings for `createdAt >= since`, worst first. Synchronous like
 * every other `usage_events` read (better-sqlite3's driver is synchronous).
 */
export function getBurnFindings(since: number): BurnFinding[] {
	const db = getDb();
	const turnRows = db
		.select({
			sessionId: usageEventsTable.sessionId,
			repoId: usageEventsTable.repoId,
			provider: usageEventsTable.provider,
			model: usageEventsTable.model,
			costUsd: usageEventsTable.costUsd,
			inputTokens: usageEventsTable.inputTokens,
			outputTokens: usageEventsTable.outputTokens,
			cacheReadTokens: usageEventsTable.cacheReadTokens,
			cacheWriteTokens: usageEventsTable.cacheWriteTokens,
			reasoningTokens: usageEventsTable.reasoningTokens,
			providerContextTokens: usageEventsTable.providerContextTokens,
			createdAt: usageEventsTable.createdAt,
		})
		.from(usageEventsTable)
		.where(
			// Only the Session's own turns feed the per-turn checks (D/C/M):
			// judge calls (ADR-0046) run on their own fresh context, so a deep
			// or rehydrated judge call says nothing about the Session it
			// scored. Finding S reads judge rows in its own query below, where
			// the judge-vs-scored comparison *is* the question (ADR-0051 §6).
			and(
				gte(usageEventsTable.createdAt, since),
				eq(usageEventsTable.purpose, "turn"),
			),
		)
		// `createdAt` is second-resolution, so same-second turns tie; rowid is
		// insertion order, which is turn-completion order — the tiebreak the
		// rehydration check's "previous turn" walk depends on.
		.orderBy(asc(usageEventsTable.createdAt), sql`rowid`)
		.all();
	const judgeRows = db
		.select({
			sessionId: usageEventsTable.sessionId,
			repoId: usageEventsTable.repoId,
			provider: usageEventsTable.provider,
			model: usageEventsTable.model,
			inputTokens: usageEventsTable.inputTokens,
			outputTokens: usageEventsTable.outputTokens,
			costUsd: usageEventsTable.costUsd,
			createdAt: usageEventsTable.createdAt,
		})
		.from(usageEventsTable)
		.where(
			and(
				gte(usageEventsTable.createdAt, since),
				eq(usageEventsTable.purpose, "judge"),
			),
		)
		.orderBy(asc(usageEventsTable.createdAt), sql`rowid`)
		.all();

	const bySession = new Map<string, SessionTurns>();
	// Total recorded spend per Session in range, all purposes — the fan-out
	// finding's child/own comparison. Delegated Sessions are ordinary
	// Sessions whose spend lands here like anyone else's.
	const spendBySession = new Map<string, number>();
	for (const row of turnRows) {
		let entry = bySession.get(row.sessionId);
		if (!entry) {
			entry = { sessionId: row.sessionId, repoId: row.repoId, rows: [] };
			bySession.set(row.sessionId, entry);
		}
		// Latest turn's repoId wins — the freshest attribution, same rule as
		// SessionManager.resolveProviderModel for provider/model.
		entry.repoId = row.repoId;
		entry.rows.push(row);
		spendBySession.set(
			row.sessionId,
			(spendBySession.get(row.sessionId) ?? 0) + row.costUsd,
		);
	}
	const judgesBySession = new Map<string, JudgeRow[]>();
	for (const row of judgeRows) {
		let entry = judgesBySession.get(row.sessionId);
		if (!entry) {
			entry = [];
			judgesBySession.set(row.sessionId, entry);
		}
		entry.push(row);
		spendBySession.set(
			row.sessionId,
			(spendBySession.get(row.sessionId) ?? 0) + row.costUsd,
		);
	}

	// Every other purpose (subagent runs, ADR-0053) is real spend of the
	// Session that triggered it, so it counts toward "all purposes" above —
	// only the total is needed, no per-row checks read these.
	const otherSpend = db
		.select({
			sessionId: usageEventsTable.sessionId,
			costUsd: sql<number>`sum(${usageEventsTable.costUsd})`,
		})
		.from(usageEventsTable)
		.where(
			and(
				gte(usageEventsTable.createdAt, since),
				notInArray(usageEventsTable.purpose, ["turn", "judge"]),
			),
		)
		.groupBy(usageEventsTable.sessionId)
		.all();
	for (const row of otherSpend) {
		spendBySession.set(
			row.sessionId,
			(spendBySession.get(row.sessionId) ?? 0) + (row.costUsd ?? 0),
		);
	}

	const candidates: Candidate[] = [];
	for (const session of bySession.values()) {
		const resolved = resolveTurns(session);
		const overdepth = overdepthFinding(session, resolved);
		if (overdepth) candidates.push(overdepth);
		const cache = cacheRehydrationFinding(session, resolved);
		if (cache) candidates.push(cache);
		const think = overthinkingFinding(session, resolved);
		if (think) candidates.push(think);
	}
	candidates.push(...fanoutCandidates(spendBySession, bySession));
	candidates.push(...judgeCandidates(judgesBySession));

	const skillFindings = unusedSkillFindings(since);
	const toolFindings = unusedToolFindings(since);

	// Worst first: largest estimated waste, then severity. Null waste
	// (unpriced models, and the fan-out shape's deliberate "real work, not
	// waste") ranks below every priced figure; ties break toward the louder
	// severity, then deterministically. Skill and tool findings (already
	// shaped) ride the same list — the cap is shared, so a check earns its
	// slot on the card against the others, not against nothing.
	type Merged =
		| { kind: "candidate"; candidate: Candidate }
		| { kind: "skill"; finding: BurnFinding }
		| { kind: "tool"; finding: BurnFinding };
	const merged: Merged[] = [
		...candidates.map(
			(candidate): Merged => ({ kind: "candidate", candidate }),
		),
		...skillFindings.map((finding): Merged => ({ kind: "skill", finding })),
		...toolFindings.map((finding): Merged => ({ kind: "tool", finding })),
	];
	const wasteOf = (m: Merged) =>
		m.kind === "candidate" ? m.candidate.wasteUsd : m.finding.wasteUsd;
	const severityOf = (m: Merged) =>
		m.kind === "candidate" ? m.candidate.severity : m.finding.severity;
	merged.sort((a, b) => {
		const wasteGap = (wasteOf(b) ?? -1) - (wasteOf(a) ?? -1);
		if (wasteGap !== 0) return wasteGap;
		const severityGap =
			SEVERITY_RANK[severityOf(b)] - SEVERITY_RANK[severityOf(a)];
		if (severityGap !== 0) return severityGap;
		const keyOf = (m: Merged) =>
			m.kind === "candidate"
				? `${m.candidate.check}\u0000${m.candidate.sessionId}`
				: `${m.finding.check}\u0000${m.finding.repoId ?? ""}\u0000${m.finding.title ?? ""}`;
		return keyOf(a).localeCompare(keyOf(b));
	});

	const top = merged.slice(0, BURN_FINDINGS_LIMIT);
	if (top.length === 0) return [];

	const candidateTop = top.filter(
		(m): m is Extract<Merged, { kind: "candidate" }> => m.kind === "candidate",
	);
	const titleById = resolveSessionTitles([
		...new Set([
			...candidateTop.map((m) => m.candidate.sessionId),
			// Fan-out evidence names the largest child, whose title resolves in
			// the same batch.
			...candidateTop.flatMap((m) =>
				m.candidate.check === "expensive-delegation" &&
				m.candidate.kind === "fanout"
					? m.candidate.topChildId
						? [m.candidate.topChildId]
						: []
					: [],
			),
		]),
	]);
	// Whether each candidate Session ever compacted (live `sessions` rows
	// only — the ADR-0024 archive doesn't carry compaction state, so deleted
	// Sessions' evidence just omits the compaction sentence).
	const compactedById = new Map(
		db
			.select({
				id: sessionsTable.id,
				compactedSummary: sessionsTable.compactedSummary,
			})
			.from(sessionsTable)
			.where(
				inArray(
					sessionsTable.id,
					candidateTop.map((m) => m.candidate.sessionId),
				),
			)
			.all()
			.map((row) => [row.id, row.compactedSummary != null] as const),
	);

	return top.map((m) =>
		m.kind === "candidate"
			? {
					check: m.candidate.check,
					severity: m.candidate.severity,
					sessionId: m.candidate.sessionId,
					repoId: m.candidate.repoId,
					title: titleById.get(m.candidate.sessionId) ?? null,
					evidence: candidateEvidence(m.candidate, compactedById, titleById),
					wasteUsd: m.candidate.wasteUsd,
					action: null,
				}
			: m.finding,
	);
}

/** One (provider, model) row of a Repo's in-range model mix, with its
 * resolved uncached input rate (null when out-of-catalog/unpriced). */
type ModelMixRow = {
	provider: string;
	model: string;
	turns: number;
	rate: number | null;
};

/**
 * Finding K — unused skills (issue #295). A skill enabled for a Repo but
 * never loaded via `read_skill` in the range. Its cost is real but small
 * per turn: progressive disclosure puts only the skill's name + description
 * (one prompt line) in every Session's system prompt, so the waste is that
 * line's size × the turns it was carried through × the input price of the
 * model the Repo actually ran. Hence `info` severity — a hygiene finding,
 * not an incident. Unlike every other burn check, the finding is directly
 * actionable in-dilna: dilna *is* the config, so the shared
 * `BurnFindingAction` carries a disable-for-Repo affordance whose execution
 * (the existing `POST /api/skills/:id/enabled` with `enabled: false`) both
 * stops the carry on Sessions started afterwards and clears the finding.
 *
 * The verdict is deliberately conservative about the forward-only fact
 * capture (issue #292): a Repo only has turns *of opportunity* for a skill
 * once turns that (a) carry tool/skill facts and (b) belong to Sessions
 * started while the skill was enabled — the system prompt freezes at
 * Session start (ADR-0049), so earlier Sessions never carried it — number
 * at least `MIN_FACT_TURNS`. Below that, "never loaded" is
 * indistinguishable from "no data yet" and the check stays silent; an
 * empty or thin fact set is never read as evidence of disuse. A skill
 * loaded at least once in the range (by name, matching what `read_skill`
 * was called with) produces no finding, however rarely it was used.
 *
 * Waste figure: the dominant priced model in the Repo's range (most turns
 * first) supplies the rate; if no model in range has a catalog input price,
 * the finding ships without a $ figure (empty-slice rule). The rate is the
 * *uncached* input price — an upper bound, since prompt caching absorbs
 * most of a stable prefix in practice — and the evidence says so. Turn
 * counts use the Session's start time (live row, else ADR-0024 archive,
 * else the turn's own stamp — an orphaned turn can only over-qualify its
 * Session, never under-qualify a verdict's window).
 */
function unusedSkillFindings(since: number): BurnFinding[] {
	const db = getDb();

	// Every turn in range that carries facts, joined to whatever recorded the
	// Session's start. Judge rows are excluded structurally by purpose (same
	// rule as finding D and the tool-usage table): a judge call never invokes
	// `read_skill` and is nobody's Session work.
	const factRows = db
		.select({
			repoId: usageEventsTable.repoId,
			createdAt: usageEventsTable.createdAt,
			toolFactsJson: usageEventsTable.toolFactsJson,
			sessionCreatedAt: sessionsTable.createdAt,
			archivedCreatedAt: sessionArchiveTable.createdAt,
		})
		.from(usageEventsTable)
		.leftJoin(sessionsTable, eq(sessionsTable.id, usageEventsTable.sessionId))
		.leftJoin(
			sessionArchiveTable,
			eq(sessionArchiveTable.sessionId, usageEventsTable.sessionId),
		)
		.where(
			and(
				gte(usageEventsTable.createdAt, since),
				eq(usageEventsTable.purpose, "turn"),
				isNotNull(usageEventsTable.toolFactsJson),
			),
		)
		.all();

	// Per Repo: which skills `read_skill` loaded in range, and when each
	// fact-carrying turn's Session started (the carry test is against
	// `repo_skills.enabled_at`, not the turn's own date).
	const loadedByRepo = new Map<string, Set<string>>();
	const sessionStartsByRepo = new Map<string, number[]>();
	for (const row of factRows) {
		let facts: { skills?: Record<string, unknown> };
		try {
			facts = JSON.parse(row.toolFactsJson as string);
		} catch {
			// dilna wrote this JSON itself; skip a corrupt row rather than fail
			// the whole card (same degradation as the tool-usage table).
			continue;
		}
		let loaded = loadedByRepo.get(row.repoId);
		if (!loaded) {
			loaded = new Set();
			loadedByRepo.set(row.repoId, loaded);
		}
		for (const [name, count] of Object.entries(facts.skills ?? {})) {
			if (typeof count === "number" && count > 0) loaded.add(name);
		}
		const starts = sessionStartsByRepo.get(row.repoId) ?? [];
		starts.push(row.sessionCreatedAt ?? row.archivedCreatedAt ?? row.createdAt);
		sessionStartsByRepo.set(row.repoId, starts);
	}

	// The Repo's model mix in range (all turn rows, facts or not) decides
	// whose price the waste figure borrows: the dominant priced model.
	const mix = db
		.select({
			repoId: usageEventsTable.repoId,
			provider: usageEventsTable.provider,
			model: usageEventsTable.model,
			turns: sql<number>`count(*)`,
		})
		.from(usageEventsTable)
		.where(
			and(
				gte(usageEventsTable.createdAt, since),
				eq(usageEventsTable.purpose, "turn"),
			),
		)
		.groupBy(
			usageEventsTable.repoId,
			usageEventsTable.provider,
			usageEventsTable.model,
		)
		.all();

	const modelByRepo = new Map<string, ModelMixRow>();
	const rateMemo = new Map<string, number | null>();
	const inputRateOf = (provider: string, model: string): number | null => {
		const key = `${provider}\u0000${model}`;
		let rate = rateMemo.get(key);
		if (rate === undefined) {
			const resolved = resolveSummarizationModel(provider, model);
			rate = resolved && resolved.cost.input > 0 ? resolved.cost.input : null;
			rateMemo.set(key, rate);
		}
		return rate;
	};
	// Dominant model per Repo: most turns first, deterministic on ties; the
	// most-used model carries the estimate, and only if it (then each
	// runner-up) has no catalog price does the finding go figure-less.
	const perRepo = new Map<string, ModelMixRow[]>();
	for (const row of mix) {
		const list = perRepo.get(row.repoId) ?? [];
		list.push({
			provider: row.provider,
			model: row.model,
			turns: row.turns,
			rate: inputRateOf(row.provider, row.model),
		});
		perRepo.set(row.repoId, list);
	}
	for (const [repoId, list] of perRepo) {
		list.sort(
			(a, b) =>
				b.turns - a.turns ||
				a.provider.localeCompare(b.provider) ||
				a.model.localeCompare(b.model),
		);
		const priced = list.find((m) => m.rate != null);
		if (priced) modelByRepo.set(repoId, priced);
	}

	const enabled = db
		.select({
			skillId: skillsTable.id,
			name: skillsTable.name,
			description: skillsTable.description,
			repoId: repoSkillsTable.repoId,
			enabledAt: repoSkillsTable.enabledAt,
		})
		.from(repoSkillsTable)
		.innerJoin(skillsTable, eq(skillsTable.id, repoSkillsTable.skillId))
		.all();

	const findings: BurnFinding[] = [];
	for (const row of enabled) {
		const starts = sessionStartsByRepo.get(row.repoId) ?? [];
		const carried = starts.filter((start) => start >= row.enabledAt).length;
		// Sparse/absent facts are "no verdict yet", not "unused" — the
		// observation window is the whole point of MIN_FACT_TURNS.
		if (carried < MIN_FACT_TURNS) continue;
		if (loadedByRepo.get(row.repoId)?.has(row.name)) continue;

		// What progressive disclosure actually inserts per Session: one line
		// of `formatSkillsPrompt`'s listing, tokens estimated at the library's
		// flat chars/4 — a couple of prose lines whose provider mix the skill
		// doesn't control.
		const line = `- ${row.name}: ${row.description}`;
		const descTokens = Math.ceil(line.length / LIBRARY_CHARS_PER_TOKEN);
		const pricedModel = modelByRepo.get(row.repoId);
		const rate = pricedModel?.rate ?? null;
		const wasteUsd =
			rate != null ? (descTokens * carried * rate) / 1_000_000 : null;

		const action: BurnFindingAction = {
			kind: "disable-skill-for-repo",
			skillId: row.skillId,
			skillName: row.name,
		};
		findings.push({
			check: "repo-unused-skill",
			severity: "info",
			sessionId: null,
			repoId: row.repoId,
			title: row.name,
			evidence: unusedSkillEvidence({
				name: row.name,
				descTokens,
				carried,
				pricedModel: pricedModel ?? null,
				wasteUsd,
			}),
			wasteUsd,
			action,
		});
	}
	return findings;
}

/** Finding K's evidence — self-contained, rendered verbatim by the web:
 * what is unused, what carrying it costs, on whose price the estimate sits,
 * and what doing something about it does. */
function unusedSkillEvidence(input: {
	name: string;
	descTokens: number;
	carried: number;
	pricedModel: { provider: string; model: string } | null;
	wasteUsd: number | null;
}): string {
	const parts = [
		`Never loaded via read_skill in the range, yet enabled for this repo — progressive disclosure still puts its name + description (~${formatTokenCount(input.descTokens)} per turn) in every Session's system prompt.`,
	];
	parts.push(
		input.wasteUsd != null && input.pricedModel
			? `Carried through ${input.carried} turns of Sessions started while it was enabled, ≈ ${formatUsd(input.wasteUsd)} at ${input.pricedModel.provider}/${input.pricedModel.model}'s uncached input rate — an upper bound; prompt caching usually absorbs most of a stable prefix.`
			: `Carried through ${input.carried} turns of Sessions started while it was enabled; the models used in range have no price in the catalog, so the finding carries no dollar figure — never a computed zero.`,
	);
	parts.push(
		"Disabling it for this repo stops the carry on Sessions started afterwards and clears this finding.",
	);
	return parts.join(" ");
}

/** Resolve every turn row's catalog Model once — the window drives the
 * depth, the rate card drives pricing, and all three per-turn checks read
 * both. */
/**
 * Finding T — unused built-in tools (issue #296). dilna registers the same
 * 14-tool set on every ordinary Session (`startPi`), and the provider bills
 * those declarations as prompt tokens on every turn — used or not. The
 * per-turn facts #292 stamps record what each turn actually called, so a
 * built-in with zero (or barely any) calls across a long enough observation
 * window is paying rent for nothing.
 *
 * Instance-scoped by design (`sessionId`/`repoId` null, `title` = the
 * tool's wire name): the toolset is identical on every Session, so the
 * disable question — never a one-click action here — is about the
 * instance's use, not one Session's.
 *
 * Deliberately more advisory than finding K: several of these tools are
 * structural (an Agent without bash/task isn't dilna), so each finding
 * carries the situational-vs-structural distinction
 * (`TOOL_BURN_CLASSIFICATION`) as its severity — structural tools surface
 * at `info` as informational-only verdicts, situational ones at `warning`
 * — and no `BurnFindingAction` is offered for either (dilna has no
 * tool-enablement config to drive).
 *
 * Thresholds (the module's "absence of data must not be read as proof a
 * tool is unused" rule): the observation window counts only fact-stamped
 * turn rows — pre-#292 turns carry no facts and are never read as "called
 * nothing" — and must reach `MIN_TOOL_OBSERVATION_TURNS` before anything
 * fires. A tool fires when it has zero calls in the window or sits under
 * `RARE_TOOL_RATE`; anything more used produces no finding at all.
 *
 * Waste = the tool's measured schema weight (`toolSchemaWeight.ts`) priced
 * at each observed turn's own blended prompt-side rate — the catalog rates
 * over that turn's actual input/cache-read/cache-write mix, so caching
 * discounts and compaction re-writes are reflected as they actually
 * happened. Turns on unpriced or out-of-catalog models can't contribute a
 * rate; they still count toward the window and the usage counts, and the
 * finding's $ figure then covers the priceable subset (noted in the
 * evidence) — or is null when no turn is priceable, per the module doc's
 * empty-slice rule. This is a deliberate divergence from finding D's
 * any-unpriced-poisons-the-finding rule: D is per-Session (one model, so
 * one unpriceable row really does poison every number), while T aggregates
 * across every model in the range, where mixed pricing is the normal case
 * and nulling the finding over one unpriced Session would hide measurable
 * waste behind it.
 */
function unusedToolFindings(since: number): BurnFinding[] {
	const db = getDb();

	// The orchestrator (ADR-0021) runs a completely different toolset (its
	// own `dilna_*` tools, no filesystem tools) on the same turn-purpose
	// rows, so its turns must neither contribute to the window nor dilute
	// the usage counts. Live rows only: the ADR-0024 archive carries no
	// kind, and a deleted Session's turns counting as ordinary is the same
	// tolerance finding D already applies to deleted Sessions.
	const orchestratorIds = new Set(
		db
			.select({ id: sessionsTable.id })
			.from(sessionsTable)
			.where(eq(sessionsTable.kind, "orchestrator"))
			.all()
			.map((row) => row.id),
	);

	const rows = (
		db
			.select({
				sessionId: usageEventsTable.sessionId,
				provider: usageEventsTable.provider,
				model: usageEventsTable.model,
				inputTokens: usageEventsTable.inputTokens,
				cacheReadTokens: usageEventsTable.cacheReadTokens,
				cacheWriteTokens: usageEventsTable.cacheWriteTokens,
				toolFactsJson: usageEventsTable.toolFactsJson,
			})
			.from(usageEventsTable)
			.where(
				// Judge rows (ADR-0046) are excluded by purpose like everywhere
				// else on this seam — they run on their own fresh context with
				// no tools, and `recordJudgeUsage` stamps no facts anyway.
				and(
					gte(usageEventsTable.createdAt, since),
					eq(usageEventsTable.purpose, "turn"),
					isNotNull(usageEventsTable.toolFactsJson),
				),
			)
			.all() as FactRow[]
	).filter((row) => !orchestratorIds.has(row.sessionId));

	// The no-data guard: without enough recorded turns the honest verdict is
	// "not observed yet" — no finding for any tool, used or not.
	if (rows.length < MIN_TOOL_OBSERVATION_TURNS) return [];

	const calls = new Map<ToolName, number>();
	for (const row of rows) {
		let facts: { tools?: Record<string, unknown> };
		try {
			facts = JSON.parse(row.toolFactsJson as string);
		} catch {
			// dilna wrote this JSON itself — corruption, not input; skip the
			// row (same degradation as `getToolUsage`) rather than fail the
			// card.
			continue;
		}
		for (const [name, count] of Object.entries(facts.tools ?? {})) {
			// Names outside the built-in universe (codegraph — conditionally
			// registered — the orchestrator's tools, MCP servers) are other
			// findings' business; recording them would claim a schema weight
			// this module never measured.
			if (!isBuiltInToolName(name)) continue;
			if (typeof count === "number" && count > 0) {
				calls.set(name, (calls.get(name) ?? 0) + count);
			}
		}
	}

	// Per-turn blended prompt-side rate — what one token riding in that
	// turn's prompt actually cost, given the turn's real caching mix. Null
	// when the turn's model has no catalog price (or the row is degenerate):
	// those turns stay in the window but can't price a schema.
	const rateByRow = rows.map((row) => blendedPromptRate(row));
	const pricedTurns = rateByRow.filter((r) => r !== null).length;

	const findings: BurnFinding[] = [];
	for (const name of TOOL_NAMES) {
		const toolCalls = calls.get(name) ?? 0;
		const usageRate = toolCalls / rows.length;
		if (toolCalls > 0 && usageRate >= RARE_TOOL_RATE) continue;

		// Waste over the priceable turns; null only when nothing is priceable
		// (the finding still fires — see the doc's divergence note).
		const wasteUsd =
			pricedTurns === 0
				? null
				: rows.reduce(
						(sum, row, i) =>
							sum + (rateByRow[i] ?? 0) * toolSchemaTokens(name, row.provider),
						0,
					);

		findings.push({
			check: "unused-tool",
			severity:
				TOOL_BURN_CLASSIFICATION[name] === "structural" ? "info" : "warning",
			sessionId: null,
			repoId: null,
			title: name,
			evidence: unusedToolEvidence(
				name,
				toolCalls,
				rows.length,
				wasteUsd,
				pricedTurns,
			),
			wasteUsd,
			// No one-click resolution exists for a built-in tool — see the
			// doc's advisory-only note.
			action: null,
		});
	}
	// Ordering is the merged worst-first sort's job (waste, then severity,
	// then the deterministic key) — this list is unordered input to it.
	return findings;
}

/** One fact-stamped turn row, narrowed to what finding T reads. */
type FactRow = {
	sessionId: string;
	provider: string;
	model: string;
	inputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	toolFactsJson: unknown;
};

/** Catalog price of one token riding in the row's prompt, averaged over the
 * turn's actual input/cache-read/cache-write mix. Null when the model is out
 * of the catalog or unpriced (same `priced` rule as finding D), or the row
 * records no prompt-side tokens at all. The catalog's rates are $ per
 * million tokens — pi-ai's own `calculateCost` is the unit reference
 * (`rates.input / 1e6 × tokens`); base rates only, ignoring `cost.tiers`,
 * since this prices a hypothetical token, not the row's recorded spend. */
function blendedPromptRate(row: FactRow): number | null {
	const model = resolveSummarizationModel(row.provider, row.model);
	const cost = model?.cost;
	if (
		!cost ||
		!(
			cost.input > 0 ||
			cost.output > 0 ||
			cost.cacheRead > 0 ||
			cost.cacheWrite > 0
		)
	) {
		return null;
	}
	const promptTokens =
		row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens;
	if (promptTokens <= 0) return null;
	const promptCost =
		(row.inputTokens * cost.input +
			row.cacheReadTokens * cost.cacheRead +
			row.cacheWriteTokens * cost.cacheWrite) /
		1_000_000;
	return promptCost / promptTokens;
}

function isBuiltInToolName(name: string): name is ToolName {
	return (TOOL_NAMES as readonly string[]).includes(name);
}

/** The finding's human-readable evidence — self-contained, rendered verbatim
 * by the web: usage counts, the schema weight, the $ estimate, and the
 * situational/structural verdict with its (non-)action. No leading tool
 * name: the card renders the finding's `title` (the wire name) right beside
 * this. */
function unusedToolEvidence(
	name: ToolName,
	calls: number,
	observedTurns: number,
	wasteUsd: number | null,
	pricedTurns: number,
): string {
	const usage =
		calls === 0
			? `0 calls across ${observedTurns} observed turns`
			: `${calls} ${calls === 1 ? "call" : "calls"} across ${observedTurns} observed turns — under the ${Math.round(RARE_TOOL_RATE * 100)}% barely-used line`;
	const parts = [
		`${usage}, while its ~${formatTokenCount(toolSchemaTokens(name, "anthropic"))}-token schema rode in every turn's input — the declaration is billed as prompt tokens whether the tool is used or not.`,
	];
	if (wasteUsd == null) {
		parts.push(
			"No model behind these turns has a price in the catalog, so the finding carries no dollar figure — never a computed zero.",
		);
	} else {
		parts.push(
			`Estimated waste of carrying it unused: ~${formatUsd(wasteUsd)}.`,
		);
		if (pricedTurns < observedTurns) {
			parts.push(
				`The estimate covers the ${pricedTurns} of ${observedTurns} observed turns whose model has a catalog price; the rest are unmeasurable.`,
			);
		}
	}
	parts.push(
		TOOL_BURN_CLASSIFICATION[name] === "structural"
			? "Structural — dilna's coding loop depends on it, so this is informational only; zero calls over a window this long may signal a broken tool rather than a saving."
			: "Situational — consider whether it earns its keep here; advisory only, since dilna has no tool-disable switch.",
	);
	return parts.join(" ");
}

function resolveTurns(turns: SessionTurns): ResolvedTurn[] {
	return turns.rows.map((row) => {
		const model = resolveSummarizationModel(row.provider, row.model);
		const window = model?.contextWindow ?? 0;
		const cost = model?.cost;
		return {
			...row,
			catalog: model,
			window,
			depth:
				row.providerContextTokens != null &&
				row.providerContextTokens > 0 &&
				window > 0
					? row.providerContextTokens / window
					: null,
			prefixTokens:
				row.providerContextTokens != null && row.providerContextTokens > 0
					? // The prompt side of the reported context: everything before
						// this turn's own output (reasoning bills within output).
						Math.max(0, row.providerContextTokens - row.outputTokens)
					: null,
			priced:
				cost != null &&
				(cost.input > 0 ||
					cost.output > 0 ||
					cost.cacheRead > 0 ||
					cost.cacheWrite > 0),
		};
	});
}

/**
 * Finding D — session overdepth (the "D" in the issue's A–F finding list).
 * A Session whose provider-reported context occupancy
 * (`usage_events.provider_context_tokens` against the catalog Model's
 * window) sits *persistently* deep: the median of its comparable turns at
 * or past `OVERDEPTH_THRESHOLD`. The deepest turns of a Session are its
 * most expensive — every prompt-side token scales with occupancy — and the
 * Session's compaction state corroborates: depth is what forces compaction,
 * and the turn after each one re-writes the whole context as cache writes.
 *
 * Comparable turns need a positive provider-reported stamp and a Model
 * still in the catalog (else there is no window to be deep *of*); rows
 * predating the stamp are never treated as zero, matching the column's
 * contract.
 *
 * Waste = the depth premium over the Session's *normal* turns: each deep
 * turn's `costUsd` minus the median cost of the Session's turns that are
 * NOT flagged deep (shallow comparable turns and rows predating the
 * provider stamp), floored at zero — a deep turn that still came in cheap
 * contributes nothing, since you can't unspend by being deep. The baseline
 * deliberately excludes the penalized turns themselves: with them in the
 * median, a Session whose turns are mostly deep drags its own baseline up
 * and understates the premium. When every turn is deep the Session's data
 * offers no cheaper baseline, so its overall median is the only honest
 * denominator left. No invented denominator, no allowance percentage —
 * the Session is only ever compared to itself.
 */
function overdepthFinding(
	turns: SessionTurns,
	resolved: ResolvedTurn[],
): OverdepthCandidate | null {
	const comparable = resolved.filter(
		(r): r is ResolvedTurn & { depth: number } => r.depth != null,
	);
	if (comparable.length < MIN_REPORTED_TURNS) return null;

	const depths = comparable.map((r) => r.depth);
	const medianDepth = median(depths);
	if (medianDepth < OVERDEPTH_THRESHOLD) return null;

	const deep = resolved.filter((r) => (r.depth ?? 0) >= OVERDEPTH_THRESHOLD);
	const baselineCosts = resolved
		.filter((r) => (r.depth ?? 0) < OVERDEPTH_THRESHOLD)
		.map((r) => r.costUsd);
	const baselineCost =
		baselineCosts.length > 0
			? median(baselineCosts)
			: // Every turn is deep: no cheaper turn exists to baseline against.
				median(resolved.map((r) => r.costUsd));
	const premium = deep.reduce(
		(sum, r) => sum + Math.max(0, r.costUsd - baselineCost),
		0,
	);

	return {
		check: "session-overdepth",
		sessionId: turns.sessionId,
		repoId: turns.repoId,
		severity:
			medianDepth >= OVERDEPTH_CRITICAL_THRESHOLD ? "critical" : "warning",
		medianDepth,
		maxDepth: Math.max(...depths),
		deepTurns: deep.length,
		reportedTurns: comparable.length,
		windowTokens: median(comparable.map((r) => r.window)),
		// One unmeasurable $ anywhere poisons the baseline and the premiums
		// alike, so a single unpriced/unresolvable turn downgrades the whole
		// finding to no $ figure (module doc's empty-slice rule).
		wasteUsd: resolved.every((r) => r.priced) ? premium : null,
	};
}

/** The finding's human-readable evidence — self-contained, rendered verbatim
 * by the web. `compacted` is undefined when no live `sessions` row exists
 * (deleted Session; the archive carries no compaction state). */
function overdepthEvidence(
	candidate: OverdepthCandidate,
	compacted: boolean | undefined,
): string {
	const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;
	const parts = [
		`Context sits at ${pct(candidate.medianDepth)} of its model's ${formatTokenCount(candidate.windowTokens)} window at the median turn (deepest ${pct(candidate.maxDepth)}); ${candidate.deepTurns} of ${candidate.reportedTurns} reported turns land past the ${pct(OVERDEPTH_THRESHOLD)} line, and those turns are the Session's most expensive.`,
	];
	parts.push(
		candidate.wasteUsd != null
			? `Depth premium over the Session's own normal turns: ~${formatUsd(candidate.wasteUsd)}.`
			: `The model has no price in the catalog, so the finding carries no dollar figure — never a computed zero.`,
	);
	if (compacted === true) {
		parts.push(
			"The Session has already compacted — depth is what forces compaction, and the turn after each one re-writes the whole context as cache writes.",
		);
	} else if (compacted === false) {
		parts.push(
			"It has never compacted — the full depth is paid on every single turn.",
		);
	}
	return parts.join(" ");
}

/**
 * Finding C — cache rehydration / compaction tax. A turn whose cache-write
 * volume covers `REHYDRATION_SHARE` of its prompt prefix didn't hit the
 * cache at all: it paid the write rate to store the prefix anew. Two things
 * cause that, and the prefix's own trajectory tells them apart — history
 * only ever grows between turns, so a *shrinking* prefix means a re-seed
 * (compaction, ADR-0023, or a tool-output trim, #272) just replaced it,
 * while a re-write on a *growing* prefix is a mid-session spike: the broken-
 * prompt-prefix signature, where something invalidated a cache that should
 * have stayed warm.
 *
 * The Session's first reported turn is excluded from the tax — every
 * Session re-writes its prefix once at birth (nothing is cached yet), so
 * counting it would flag every Session equally. A finding needs
 * `MIN_REHYDRATION_TURNS` counted turns; the counted turns report as two
 * populations because the remedy differs (re-seeds are the price of
 * compaction, worth seeing at depth; spikes are a defect to investigate).
 *
 * Waste = the rehydration premium over a warm cache: each counted turn's
 * cache-write tokens at the catalog's (write − read) rate spread. This is
 * an absolute sum over the counted turns alone — no baseline mixes other
 * turns in — so only counted turns can poison it to `null` (module doc).
 */
function cacheRehydrationFinding(
	turns: SessionTurns,
	resolved: ResolvedTurn[],
): CacheCandidate | null {
	const comparable = resolved.filter((r) => r.prefixTokens != null);
	if (comparable.length === 0) return null;

	// Walk consecutive reported turns; rows are oldest-last (the query's
	// createdAt/rowid order), so `previous` is exactly the turn a re-seed
	// would have rewritten over.
	let previous: ResolvedTurn | null = null;
	const resets: ResolvedTurn[] = [];
	const spikes: ResolvedTurn[] = [];
	for (const row of comparable) {
		const prefix = row.prefixTokens as number;
		const rehydrated = row.cacheWriteTokens >= REHYDRATION_SHARE * prefix;
		if (rehydrated) {
			if (
				previous != null &&
				(previous.prefixTokens as number) >= REHYDRATION_RESET_FACTOR * prefix
			) {
				// The prefix shrank: a re-seed replaced it, and this turn paid
				// to re-write the compacted/trimmed context — the expected tax.
				resets.push(row);
			} else if (previous != null) {
				// A continuing, growing prefix written whole: the cache broke
				// mid-session.
				spikes.push(row);
			}
			// previous == null: the Session's first reported turn — excluded
			// from the tax (every Session pays it once at birth).
		}
		previous = row;
	}

	const counted = [...resets, ...spikes];
	if (counted.length < MIN_REHYDRATION_TURNS) return null;

	// Every counted turn re-writes roughly the prefix it rehydrated; the
	// median across them sizes the re-write in the evidence.
	const medianRewriteTokens = median(counted.map((r) => r.cacheWriteTokens));
	const wasteUsd = counted.every((r) => r.priced)
		? counted.reduce((sum, r) => {
				const cost = r.catalog?.cost;
				if (!cost) return sum;
				return (
					sum +
					(r.cacheWriteTokens * Math.max(0, cost.cacheWrite - cost.cacheRead)) /
						1_000_000
				);
			}, 0)
		: null;

	const spikeTurns = spikes.length;
	const severity: CacheCandidate["severity"] =
		spikeTurns >= REHYDRATION_CRITICAL_SHARE * comparable.length
			? "critical"
			: spikeTurns > 0
				? "warning"
				: "info";

	return {
		check: "cache-rehydration",
		sessionId: turns.sessionId,
		repoId: turns.repoId,
		severity,
		taxTurns: counted.length,
		resetTurns: resets.length,
		spikeTurns,
		reportedTurns: comparable.length,
		medianRewriteTokens,
		wasteUsd,
	};
}

function cacheEvidence(candidate: CacheCandidate): string {
	const parts = [
		`${candidate.taxTurns} of ${candidate.reportedTurns} reported turns re-wrote their whole prompt prefix as fresh cache writes (median ${formatTokenCount(candidate.medianRewriteTokens)} tokens per re-write): ${candidate.resetTurns} after a context reset — the expected re-write of the compacted or trimmed prefix — and ${candidate.spikeTurns} mid-session, where the prefix kept growing but the provider re-read none of it, the broken-prefix signature to investigate.`,
	];
	parts.push(
		candidate.wasteUsd != null
			? `Cache-write premium over a warm cache on those turns: ~${formatUsd(candidate.wasteUsd)}.`
			: `The model has no price in the catalog, so the finding carries no dollar figure — never a computed zero.`,
	);
	return parts.join(" ");
}

/**
 * Finding M — model overthinking. A Session whose *median* turn spends
 * `OVERTHINK_THRESHOLD` of its generated output on reasoning tokens is
 * thinking more than answering: reasoning bills at the model's plain output
 * rate, so every point of reasoning share is output-rate spend. The metric
 * is the token share of output rather than a share of blended `costUsd` —
 * the token ratio is computable on every turn with any output, while the $
 * share needs the provider's blended cost split, which is unavailable
 * exactly when the model is unpriced (and the two track each other, since
 * reasoning cost is reasoning tokens × the fixed output rate).
 *
 * Comparable turns need any output at all (the share's denominator); turns
 * without output say nothing about thinking. Waste = the flagged turns'
 * reasoning tokens at the catalog's output rate — an absolute sum over the
 * flagged turns alone, so only they can poison it to `null` (module doc).
 */
function overthinkingFinding(
	turns: SessionTurns,
	resolved: ResolvedTurn[],
): ThinkCandidate | null {
	const comparable = resolved.filter((r) => r.outputTokens > 0);
	if (comparable.length < MIN_REPORTED_TURNS) return null;

	const shares = comparable.map((r) => r.reasoningTokens / r.outputTokens);
	const medianShare = median(shares);
	if (medianShare < OVERTHINK_THRESHOLD) return null;

	const flagged = comparable.filter(
		(r) => r.reasoningTokens / r.outputTokens >= OVERTHINK_THRESHOLD,
	);
	const wasteUsd = flagged.every((r) => r.priced)
		? flagged.reduce((sum, r) => {
				const outputRate = r.catalog?.cost?.output ?? 0;
				return sum + (r.reasoningTokens * outputRate) / 1_000_000;
			}, 0)
		: null;

	return {
		check: "model-overthinking",
		sessionId: turns.sessionId,
		repoId: turns.repoId,
		severity:
			medianShare >= OVERTHINK_CRITICAL_THRESHOLD ? "critical" : "warning",
		medianShare,
		peakShare: Math.max(...shares),
		flaggedTurns: flagged.length,
		reportedTurns: comparable.length,
		wasteUsd,
	};
}

function thinkEvidence(candidate: ThinkCandidate): string {
	const pct = (fraction: number) => `${Math.round(fraction * 100)}%`;
	const parts = [
		`Reasoning is ${pct(candidate.medianShare)} of generated output at the median turn (peak ${pct(candidate.peakShare)}); ${candidate.flaggedTurns} of ${candidate.reportedTurns} turns spent more tokens thinking than answering.`,
	];
	parts.push(
		candidate.wasteUsd != null
			? `Reasoning tokens bill at the model's plain output rate, so the flagged thinking cost ~${formatUsd(candidate.wasteUsd)} — the addressable part of this Session's spend.`
			: `The model has no price in the catalog, so the finding carries no dollar figure — never a computed zero.`,
	);
	return parts.join(" ");
}

/**
 * Finding S, fan-out shape — expensive delegation (issue #294). Children
 * linked via `sessions.spawnedBy` (ADR-0025) are full Sessions whose spend
 * lands in `usage_events` like anyone's; the finding surfaces an
 * orchestrator whose fan-out costs `FANOUT_RATIO` its own budget — the
 * delegation bill a spend dashboard shows only scattered across child
 * Sessions. Child spend is real work, not waste, so `wasteUsd` stays null
 * and the evidence carries the total.
 *
 * Known undercount, stated on the finding rather than silently absorbed:
 * task-tool subagents (ADR-0034) run on a throwaway in-process `Agent`
 * whose events never reach the usage normalizer — their spend is *not* in
 * `usage_events`, so the fan-out total covers spawned Sessions and judges
 * only. Fixing the capture would need a new usage purpose to avoid
 * corrupting per-turn semantics (the timeline numbers `purpose="turn"`
 * rows), which is out of scope for a read-side finding.
 */
function fanoutCandidates(
	spendBySession: Map<string, number>,
	bySession: Map<string, SessionTurns>,
): Candidate[] {
	const db = getDb();
	const childrenByOrchestrator = new Map<
		string,
		{ id: string; repoId: string }[]
	>();
	for (const row of db
		.select({
			id: sessionsTable.id,
			repoId: sessionsTable.repoId,
			spawnedBy: sessionsTable.spawnedBy,
		})
		.from(sessionsTable)
		.where(isNotNull(sessionsTable.spawnedBy))
		.all()) {
		// spawnedBy is non-null by the WHERE, but drizzle's nullable type
		// needs the narrowing before it can key a map.
		if (row.spawnedBy == null) continue;
		let entry = childrenByOrchestrator.get(row.spawnedBy);
		if (!entry) {
			entry = [];
			childrenByOrchestrator.set(row.spawnedBy, entry);
		}
		entry.push({ id: row.id, repoId: row.repoId });
	}

	const orchestratorIds = [...childrenByOrchestrator.keys()];
	const liveRepoId = new Map(
		orchestratorIds.length
			? db
					.select({ id: sessionsTable.id, repoId: sessionsTable.repoId })
					.from(sessionsTable)
					.where(inArray(sessionsTable.id, orchestratorIds))
					.all()
					.map((row) => [row.id, row.repoId] as const)
			: [],
	);

	const candidates: Candidate[] = [];
	for (const [orchestratorId, children] of childrenByOrchestrator) {
		let childSpend = 0;
		let childrenWithSpend = 0;
		let topChildId: string | null = null;
		let topChildSpend = 0;
		for (const child of children) {
			const spend = spendBySession.get(child.id) ?? 0;
			if (spend <= 0) continue;
			childrenWithSpend++;
			childSpend += spend;
			if (spend > topChildSpend) {
				topChildId = child.id;
				topChildSpend = spend;
			}
		}
		if (childrenWithSpend === 0) continue;

		const ownSpend = spendBySession.get(orchestratorId) ?? 0;
		const fires = ownSpend > 0 ? childSpend >= FANOUT_RATIO * ownSpend : true;
		if (!fires) continue;
		const ratio = ownSpend > 0 ? childSpend / ownSpend : null;

		candidates.push({
			check: "expensive-delegation",
			kind: "fanout",
			sessionId: orchestratorId,
			// The fan-out happened in the orchestrator's Repo: its own latest
			// in-range row's attribution, falling back to the live row's.
			repoId:
				bySession.get(orchestratorId)?.repoId ??
				liveRepoId.get(orchestratorId) ??
				null,
			severity:
				ratio != null && ratio >= FANOUT_CRITICAL_RATIO
					? "critical"
					: "warning",
			children: childrenWithSpend,
			childSpend,
			ownSpend,
			ratio,
			topChildId,
			topChildSpend,
			wasteUsd: null,
		});
	}
	return candidates;
}

function fanoutEvidence(
	candidate: Extract<Candidate, { kind: "fanout" }>,
	titleById: Map<string, string>,
): string {
	const scale =
		candidate.ownSpend > 0
			? `${Math.round(candidate.ratio ?? 0)}× the orchestrator's own ${formatUsd(candidate.ownSpend)}`
			: `while the orchestrator itself recorded no spend in range`;
	const topChild = candidate.topChildId
		? ` Largest child: ${titleById.get(candidate.topChildId) ?? `session ${candidate.topChildId.slice(0, 8)}…`} at ${formatUsd(candidate.topChildSpend)}.`
		: "";
	return [
		`Fan-out to ${candidate.children} child Session${candidate.children === 1 ? "" : "s"} spent ${formatUsd(candidate.childSpend)} this range — ${scale}. Child Sessions are full Sessions on their own models (ADR-0021, fire-and-forget).${topChild} Task-tool subagent spend (ADR-0034) is not in these totals — the read-only subagent's throwaway Agent never writes a usage_events row — so true delegation cost is higher than shown.`,
	].join(" ");
}

/**
 * Finding S, judge shape — judge calls (ADR-0046, `purpose="judge"`) that
 * cost more than the turn they scored. The scored turn is resolved through
 * the `turn_scores` row each scoring run writes immediately after its usage
 * row (nearest score at-or-after the judge row, within
 * `JUDGE_PAIR_WINDOW_S`), then through that turn's last `messages` row —
 * the timestamp the turn's own `purpose="turn"` usage row lands next to.
 * Pairs that can't be attributed (deleted Session — its messages are gone —
 * or no usage row within `TURN_MATCH_WINDOW_S`) are dropped rather than
 * guessed at; the finding reports how many calls it actually compared.
 *
 * Waste = Σ over paired calls of (judge cost − scored cost), floored at
 * zero per pair — a judge that came in cheaper contributes nothing. The
 * figures are recorded `costUsd` values, never catalog derivations, so the
 * comparison is priceable wherever it is computable at all and `wasteUsd`
 * is never null when the finding fires.
 */
function judgeCandidates(
	judgesBySession: Map<string, JudgeRow[]>,
): Candidate[] {
	if (judgesBySession.size === 0) return [];
	const db = getDb();

	// The pairing anchor: one `turn_scores` row per scoring run, written
	// right after that run's usage row.
	const scoresBySession = new Map<
		string,
		{ turnId: string; createdAt: number }[]
	>();
	const sessionIds = [...judgesBySession.keys()];
	for (const row of db
		.select({
			sessionId: turnScoresTable.sessionId,
			turnId: turnScoresTable.turnId,
			createdAt: turnScoresTable.createdAt,
		})
		.from(turnScoresTable)
		.where(inArray(turnScoresTable.sessionId, sessionIds))
		.orderBy(asc(turnScoresTable.createdAt))
		.all()) {
		let entry = scoresBySession.get(row.sessionId);
		if (!entry) {
			entry = [];
			scoresBySession.set(row.sessionId, entry);
		}
		entry.push({ turnId: row.turnId, createdAt: row.createdAt });
	}

	type Pair = { sessionId: string; turnId: string; judge: JudgeRow };
	const pairs: Pair[] = [];
	for (const [sessionId, judges] of judgesBySession) {
		// Two-pointer over rows sorted by createdAt (both queries order so):
		// each judge takes the first unpaired score at-or-after it, so two
		// same-second runs pair in order and an older run's score is never
		// reused.
		const scores = scoresBySession.get(sessionId) ?? [];
		let si = 0;
		for (const judge of judges) {
			let next = scores[si];
			while (next && next.createdAt < judge.createdAt) {
				si++;
				next = scores[si];
			}
			if (next && next.createdAt - judge.createdAt <= JUDGE_PAIR_WINDOW_S) {
				pairs.push({ sessionId, turnId: next.turnId, judge });
				si++;
			}
		}
	}
	if (pairs.length === 0) return [];

	// Scored-turn end = the turn's last message (batched over all pairs).
	const turnEndByTurnId = new Map<string, number>();
	const turnIds = [...new Set(pairs.map((p) => p.turnId))];
	for (const row of db
		.select({
			turnId: messagesTable.turnId,
			turnEnd: sql<number>`max(${messagesTable.createdAt})`.mapWith(Number),
		})
		.from(messagesTable)
		.where(inArray(messagesTable.turnId, turnIds))
		.groupBy(messagesTable.turnId)
		.all()) {
		if (row.turnId != null) turnEndByTurnId.set(row.turnId, row.turnEnd);
	}

	// Scored-turn spend: the `purpose="turn"` row nearest each turn end.
	// One batched point query — scored turns may predate the selected range
	// (old turns stay scoreable), so the in-range rows already loaded can't
	// answer this alone.
	const scoredCostByKey = new Map<string, number>();
	const windowKeys = new Map<string, { sessionId: string; turnEnd: number }>();
	for (const pair of pairs) {
		const end = turnEndByTurnId.get(pair.turnId);
		if (end != null) {
			windowKeys.set(`${pair.sessionId}:${end}`, {
				sessionId: pair.sessionId,
				turnEnd: end,
			});
		}
	}
	if (windowKeys.size > 0) {
		const rows = db
			.select({
				sessionId: usageEventsTable.sessionId,
				costUsd: usageEventsTable.costUsd,
				createdAt: usageEventsTable.createdAt,
			})
			.from(usageEventsTable)
			.where(
				and(
					eq(usageEventsTable.purpose, "turn"),
					or(
						...[...windowKeys.values()].map((k) =>
							and(
								eq(usageEventsTable.sessionId, k.sessionId),
								between(
									usageEventsTable.createdAt,
									k.turnEnd - TURN_MATCH_WINDOW_S,
									k.turnEnd + TURN_MATCH_WINDOW_S,
								),
							),
						),
					),
				),
			)
			.all();
		for (const [key, k] of windowKeys) {
			const inWindow = rows.filter(
				(r) =>
					r.sessionId === k.sessionId &&
					Math.abs(r.createdAt - k.turnEnd) <= TURN_MATCH_WINDOW_S,
			);
			const nearest = inWindow.reduce<number | null>(
				(best, r) =>
					best == null ||
					Math.abs(r.createdAt - k.turnEnd) < Math.abs(best - k.turnEnd)
						? r.createdAt
						: best,
				null,
			);
			const match = inWindow.find((r) => r.createdAt === nearest);
			if (match) scoredCostByKey.set(key, match.costUsd);
		}
	}

	const agg = new Map<
		string,
		{
			repoId: string;
			compared: number;
			overspending: number;
			judgeTokens: number;
			judgeSpend: number;
			scoredSpend: number;
			worstJudgeCost: number;
			worstScoredCost: number;
			worstRatio: number;
			wasteUsd: number;
		}
	>();
	for (const pair of pairs) {
		const turnEnd = turnEndByTurnId.get(pair.turnId);
		if (turnEnd == null) continue;
		const scoredCost = scoredCostByKey.get(`${pair.sessionId}:${turnEnd}`);
		if (scoredCost == null) continue;
		let entry = agg.get(pair.sessionId);
		if (!entry) {
			entry = {
				repoId: pair.judge.repoId,
				compared: 0,
				overspending: 0,
				judgeTokens: 0,
				judgeSpend: 0,
				scoredSpend: 0,
				worstJudgeCost: 0,
				worstScoredCost: 0,
				worstRatio: 0,
				wasteUsd: 0,
			};
			agg.set(pair.sessionId, entry);
		}
		entry.compared++;
		entry.judgeTokens += pair.judge.inputTokens + pair.judge.outputTokens;
		entry.judgeSpend += pair.judge.costUsd;
		entry.scoredSpend += scoredCost;
		if (pair.judge.costUsd > scoredCost) {
			entry.overspending++;
			entry.wasteUsd += pair.judge.costUsd - scoredCost;
			const ratio = scoredCost > 0 ? pair.judge.costUsd / scoredCost : 0;
			if (
				ratio >= entry.worstRatio &&
				pair.judge.costUsd >= entry.worstJudgeCost
			) {
				entry.worstRatio = ratio;
				entry.worstJudgeCost = pair.judge.costUsd;
				entry.worstScoredCost = scoredCost;
			}
		}
	}

	const candidates: Candidate[] = [];
	for (const [sessionId, entry] of agg) {
		if (entry.overspending === 0) continue;
		candidates.push({
			check: "expensive-delegation",
			kind: "judge",
			sessionId,
			repoId: entry.repoId,
			severity:
				entry.worstScoredCost > 0 && entry.worstRatio >= JUDGE_CRITICAL_RATIO
					? "critical"
					: "warning",
			compared: entry.compared,
			overspending: entry.overspending,
			judgeTokens: entry.judgeTokens,
			judgeSpend: entry.judgeSpend,
			scoredSpend: entry.scoredSpend,
			worstJudgeCost: entry.worstJudgeCost,
			worstScoredCost: entry.worstScoredCost,
			wasteUsd: entry.wasteUsd,
		});
	}
	return candidates;
}

function judgeEvidence(
	candidate: Extract<Candidate, { kind: "judge" }>,
): string {
	const worst =
		candidate.worstScoredCost > 0
			? `Worst call: ${formatUsd(candidate.worstJudgeCost)} to judge a ${formatUsd(candidate.worstScoredCost)} turn (${Math.round(candidate.worstJudgeCost / candidate.worstScoredCost)}×).`
			: `Worst call: ${formatUsd(candidate.worstJudgeCost)} to judge a turn that recorded no spend.`;
	return [
		`${candidate.overspending} of ${candidate.compared} judge calls outspent the turn they scored — ${formatTokenCount(candidate.judgeTokens)} judging tokens and ${formatUsd(candidate.judgeSpend)} of judging against ${formatUsd(candidate.scoredSpend)} of scored turns. ${worst} The judge reads the whole turn in a fresh context (ADR-0046); when judging costs more than the work it evaluates, the metric or its criteria need trimming.`,
	].join(" ");
}

function candidateEvidence(
	candidate: Candidate,
	compactedById: Map<string, boolean>,
	titleById: Map<string, string>,
): string {
	switch (candidate.check) {
		case "session-overdepth":
			return overdepthEvidence(
				candidate,
				compactedById.get(candidate.sessionId),
			);
		case "cache-rehydration":
			return cacheEvidence(candidate);
		case "model-overthinking":
			return thinkEvidence(candidate);
		case "expensive-delegation":
			return candidate.kind === "fanout"
				? fanoutEvidence(candidate, titleById)
				: judgeEvidence(candidate);
	}
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const upper = sorted[mid];
	const lower = sorted[mid - 1];
	if (upper === undefined || lower === undefined) return sorted[0] ?? 0;
	return sorted.length % 2 === 1 ? upper : (lower + upper) / 2;
}
