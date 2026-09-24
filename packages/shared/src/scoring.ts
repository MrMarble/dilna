/**
 * Output scoring (issue #251, ADR-0046): a second model judges one assistant
 * turn and attaches a 0..1 score plus its written reason.
 *
 * `"criteria"` is G-Eval-shaped — the user supplies plain-English criteria
 * and the judge scores the turn against them. `"relevancy"` needs no input
 * beyond the turn itself: how much of the answer addresses what was asked.
 * Both run as several small, confined judge calls rather than one holistic
 * "rate this 1-10" (see `apps/server/src/sessions/scoring.ts`).
 */
export const SCORE_METRICS = ["criteria", "relevancy"] as const;
export type ScoreMetric = (typeof SCORE_METRICS)[number];

/** Pass/fail cut applied when a request doesn't name one — deepeval's
 * default, and a reasonable "mostly good" bar for a 0..1 score. */
export const DEFAULT_SCORE_THRESHOLD = 0.5;

/**
 * One judged score of one turn. Keyed by `turnId` rather than a message id:
 * a turn is several `messages` rows (ADR-0026 §3), and it's the turn as a
 * whole the judge reads. A turn may carry several scores — different
 * metrics, criteria or judges — each its own row, never overwritten.
 */
export type TurnScore = {
	id: string;
	sessionId: string;
	turnId: string;
	metric: ScoreMetric;
	/** The criteria text the judge scored against; `null` for metrics that
	 * take none (`"relevancy"`). */
	criteria: string | null;
	/** The judge model, which may be a different provider than the Session's
	 * own — that's what makes cross-provider judging possible. */
	provider: string;
	model: string;
	/** 0..1 */
	score: number;
	threshold: number;
	/** `score >= threshold`, stored so a later default change can't
	 * retroactively flip an already-shown verdict. */
	passed: boolean;
	reason: string;
	createdAt: number;
};
