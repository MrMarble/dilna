import type { AgentStreamEvent } from "@dilna/shared";
import { eq, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { getDb } from "../db";
import {
	sessions as sessionsTable,
	usageEvents as usageEventsTable,
} from "../db/schema";
import { logger } from "../logger";
import { turnDrift } from "./charCalibration";
import { CONTEXT_DRIFT_THRESHOLD } from "./usageStats";

const log = logger.child({ component: "sessions/usageAccounting" });

/**
 * Token/cost accounting for a turn, extracted from `SessionManager`
 * (issue #149) — the `sessions` lifetime-total bump and its paired
 * `usage_events` row, plus the outgoing event rewrite that keeps the live
 * badge and `GET /api/sessions/:id` showing the same number.
 *
 * Fold a turn-end `usage_update` into the session's lifetime token totals,
 * and record the turn's full usage (tokens + cache + cost) as one
 * `usage_events` row for the usage dashboard (`sessions/usageStats.ts`).
 *
 * Despite the SDK docs describing result usage as cumulative "for the
 * session", in dilna's streaming-input mode it is per-turn — verified
 * empirically with two turns in one process (3319 then 2 input tokens,
 * not a running sum), and it also resets on every process respawn. So
 * the turn's value is simply added to the `sessions` row, and the
 * outgoing event's `cumulative` is rewritten to the persisted lifetime
 * total — the badge's live snap-to number is then the same one
 * `GET /api/sessions/:id` serves after a reload. Non-turn-end events
 * pass through untouched.
 *
 * `usage_events` deliberately only ever stores the token-only fields
 * that already exist on `sessions` plus the extra cache/cost fields —
 * it never reads back from `sessions`, so it's unaffected by the
 * rewrite below.
 */
export function accumulateSessionUsage(
	sessionId: string,
	ev: AgentStreamEvent,
	agent: { provider: string; model: string },
	estimatedContextTokens?: number | null,
): AgentStreamEvent {
	if (ev.type !== "usage_update" || !ev.cumulative) return ev;
	const cumulative = ev.cumulative;

	const db = getDb();
	// Transactional so a crash/error between the update and the insert
	// below can't leave `sessions`' running total bumped with no matching
	// `usage_events` row (or vice versa).
	const row = db.transaction(() => {
		db.update(sessionsTable)
			.set({
				inputTokens: sql`${sessionsTable.inputTokens} + ${cumulative.inputTokens}`,
				outputTokens: sql`${sessionsTable.outputTokens} + ${cumulative.outputTokens}`,
			})
			.where(eq(sessionsTable.id, sessionId))
			.run();
		const updated = db
			.select({
				inputTokens: sessionsTable.inputTokens,
				outputTokens: sessionsTable.outputTokens,
				repoId: sessionsTable.repoId,
			})
			.from(sessionsTable)
			.where(eq(sessionsTable.id, sessionId))
			.get();
		if (!updated) return null;

		db.insert(usageEventsTable)
			.values({
				id: nanoid(),
				sessionId,
				repoId: updated.repoId,
				provider: agent.provider || "unknown",
				model: agent.model || "unknown",
				inputTokens: cumulative.inputTokens,
				outputTokens: cumulative.outputTokens,
				cacheReadTokens: cumulative.cacheReadTokens ?? 0,
				cacheWriteTokens: cumulative.cacheWriteTokens ?? 0,
				reasoningTokens: cumulative.reasoningTokens ?? 0,
				costUsd: cumulative.costUsd ?? 0,
				// Stamped by the adapter on the same turn-end event (issue #267);
				// stays null when absent — e.g. an adapter that doesn't report
				// context occupancy — never coerced to 0.
				providerContextTokens: ev.providerContextTokens ?? null,
				// dilna's own estimate for the same turn (issue #270), passed by
				// the caller from the live Agent's transcript; null when the
				// model has fallen out of the catalog (nothing to calibrate
				// against).
				estimatedContextTokens: estimatedContextTokens ?? null,
			})
			.run();
		return updated;
	});
	if (!row) return ev;

	// Per-turn drift signal (issue #270): both stamps on one row make the
	// estimator's error a log line, not an argument. Aggregate drift per
	// Session is the Metrics page's drift list (usageStats.getContextDrift);
	// this is the per-turn tripwire past CONTEXT_DRIFT_THRESHOLD.
	const reported = ev.providerContextTokens;
	if (
		reported !== undefined &&
		reported > 0 &&
		estimatedContextTokens != null
	) {
		const drift = turnDrift(estimatedContextTokens, reported);
		if (drift !== null && Math.abs(drift) > CONTEXT_DRIFT_THRESHOLD) {
			log.warn(
				{
					sessionId,
					provider: agent.provider,
					model: agent.model,
					estimated: estimatedContextTokens,
					reported,
					driftPct: Math.round(drift * 100),
				},
				"context estimate drifts past threshold vs provider report",
			);
		}
	}

	return {
		...ev,
		cumulative: {
			inputTokens: row.inputTokens,
			outputTokens: row.outputTokens,
		},
	};
}
