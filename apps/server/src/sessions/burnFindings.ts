import type { BurnFinding } from "@dilna/shared";
import { formatTokenCount, formatUsd } from "@dilna/shared";
import { and, eq, gte, inArray } from "drizzle-orm";
import { resolveSummarizationModel } from "../agents/pi";
import { getDb } from "../db";
import {
	sessions as sessionsTable,
	usageEvents as usageEventsTable,
} from "../db/schema";
import { resolveSessionTitles } from "./usageStats";

/**
 * Burn findings (issue #291, ADR-0051) — the judgment layer over the spend
 * `usageStats.ts` measures. Each check turns raw `usage_events` rows (plus,
 * where relevant, the Session's compaction fields) into a `BurnFinding`: a
 * severity, human-readable evidence, and an estimated $ waste. Everything is
 * computed here, in one place, over the same time range as the usage summary
 * — the web renders the shared `BurnFinding` shape verbatim and computes
 * nothing (same single-home policy as `cacheHitRate`).
 *
 * Pricing follows the empty-slice rule the rest of the summary already uses:
 * a Model with no price in the catalog (custom-provider models are built
 * with an all-zero cost, and out-of-catalog ids resolve to nothing) yields a
 * finding *without* a $ figure (`wasteUsd: null`) — never a computed 0,
 * which would read as "free" rather than "unmeasurable".
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
 * drift list's `turns` field. */
const MIN_REPORTED_TURNS = 3;

/** How many findings the Burn checks card shows, worst first — same cap
 * shape as the top-spend and drift lists. */
const BURN_FINDINGS_LIMIT = 10;

/** One turn row, narrowed to what the checks read. */
type TurnRow = {
	repoId: string;
	provider: string;
	model: string;
	costUsd: number;
	providerContextTokens: number | null;
};

/** One Session's turn rows in range, oldest last. */
type SessionTurns = {
	sessionId: string;
	repoId: string;
	rows: TurnRow[];
};

/** Internal finding-D verdict for one Session, before titles/compaction are
 * resolved onto the shared shape. */
type OverdepthCandidate = {
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

/**
 * Burn findings for `createdAt >= since`, worst first. Synchronous like
 * every other `usage_events` read (better-sqlite3's driver is synchronous).
 */
export function getBurnFindings(since: number): BurnFinding[] {
	const db = getDb();
	const rows = db
		.select({
			sessionId: usageEventsTable.sessionId,
			repoId: usageEventsTable.repoId,
			provider: usageEventsTable.provider,
			model: usageEventsTable.model,
			costUsd: usageEventsTable.costUsd,
			providerContextTokens: usageEventsTable.providerContextTokens,
			createdAt: usageEventsTable.createdAt,
		})
		.from(usageEventsTable)
		.where(
			// Judge calls (ADR-0046) run on their own fresh context; a deep
			// judge call says nothing about the Session it scored.
			and(
				gte(usageEventsTable.createdAt, since),
				eq(usageEventsTable.purpose, "turn"),
			),
		)
		.orderBy(usageEventsTable.createdAt)
		.all();

	const bySession = new Map<string, SessionTurns>();
	for (const row of rows) {
		let entry = bySession.get(row.sessionId);
		if (!entry) {
			entry = { sessionId: row.sessionId, repoId: row.repoId, rows: [] };
			bySession.set(row.sessionId, entry);
		}
		// Latest turn's repoId wins — the freshest attribution, same rule as
		// SessionManager.resolveProviderModel for provider/model.
		entry.repoId = row.repoId;
		entry.rows.push(row);
	}

	const candidates = [...bySession.values()]
		.map(overdepthFinding)
		.filter((f): f is OverdepthCandidate => f !== null);

	// Worst first: largest estimated waste, then deepest median occupancy.
	// Null waste (unpriced models) ranks below every priced figure.
	candidates.sort((a, b) => {
		const wasteGap = (b.wasteUsd ?? -1) - (a.wasteUsd ?? -1);
		return wasteGap !== 0 ? wasteGap : b.medianDepth - a.medianDepth;
	});

	const top = candidates.slice(0, BURN_FINDINGS_LIMIT);
	if (top.length === 0) return [];

	const titleById = resolveSessionTitles(top.map((f) => f.sessionId));
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
					top.map((f) => f.sessionId),
				),
			)
			.all()
			.map((row) => [row.id, row.compactedSummary != null] as const),
	);

	return top.map((candidate) => ({
		check: "session-overdepth" as const,
		severity: candidate.severity,
		sessionId: candidate.sessionId,
		repoId: candidate.repoId,
		title: titleById.get(candidate.sessionId) ?? null,
		evidence: overdepthEvidence(
			candidate,
			compactedById.get(candidate.sessionId),
		),
		wasteUsd: candidate.wasteUsd,
	}));
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
function overdepthFinding(turns: SessionTurns): OverdepthCandidate | null {
	// One catalog lookup per row: the resolved Model drives both the depth
	// (its window) and the pricing (its rate card), and the previous pass
	// resolved each row twice for those two questions.
	const resolved = turns.rows.map((row) => {
		const model = resolveSummarizationModel(row.provider, row.model);
		const window = model?.contextWindow ?? 0;
		const cost = model?.cost;
		return {
			costUsd: row.costUsd,
			priced:
				cost != null &&
				(cost.input > 0 ||
					cost.output > 0 ||
					cost.cacheRead > 0 ||
					cost.cacheWrite > 0),
			depth:
				row.providerContextTokens != null &&
				row.providerContextTokens > 0 &&
				window > 0
					? row.providerContextTokens / window
					: null,
			window,
		};
	});
	const comparable = resolved.filter(
		(r): r is (typeof resolved)[number] & { depth: number } => r.depth != null,
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

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const upper = sorted[mid];
	const lower = sorted[mid - 1];
	if (upper === undefined || lower === undefined) return sorted[0] ?? 0;
	return sorted.length % 2 === 1 ? upper : (lower + upper) / 2;
}
