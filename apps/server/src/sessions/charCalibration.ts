import {
	charsPerTokenFor,
	LIBRARY_CHARS_PER_TOKEN,
} from "../agents/providerConfig";

/**
 * Calibration of dilna's per-provider context estimator against the
 * provider's own counts (issue #270).
 *
 * dilna's estimator is proportional in one knob: tokens ≈ chars /
 * `charsPerToken`. The pi adapter stamps the provider's own context count
 * for every turn (`usage_events.provider_context_tokens`, issue #267)
 * alongside dilna's estimate for the same turn
 * (`estimated_context_tokens`), so the constant that minimises squared
 * error over a real instance's turns is a weighted least-squares fit
 * through the proportional family:
 *
 *     c* = c_shipped · Σ est_i² / Σ (est_i · rep_i)
 *
 * (est_i = dilna's estimate at the shipped constant, rep_i = the provider's
 * report; substituting est_i = chars_i / c_shipped and minimising
 * Σ(chars_i/c − rep_i)² gives the closed form above.) A c* below the
 * shipped constant means the provider packs denser than assumed — dilna
 * under-counts, the dangerous direction: compaction fires too late and the
 * real window can overflow before the meter says so.
 */

/** One turn's comparable pair. Rows lacking either number (pre-#267/#270
 * rows, unknown-model turns) simply aren't samples. */
export type CalibrationSample = {
	provider: string;
	/** dilna's stamped estimate for the turn (`estimated_context_tokens`). */
	estimated: number;
	/** The provider's reported context occupancy (`provider_context_tokens`). */
	reported: number;
};

/** The constant currently shipped for `provider` — the c the samples were
 * measured against, and the value c* is expressed relative to. */
export function shippedConstant(provider: string): number {
	return charsPerTokenFor(provider);
}

/**
 * Least-squares recalibrated constant per provider, from real turn samples.
 * Providers with no usable samples are absent from the result (their
 * shipped constant stands); a provider whose samples cancel out
 * (Σ est·rep ≤ 0 can't happen with positive counts, but a degenerate
 * all-zero dump could) is likewise skipped rather than producing a
 * nonsense constant.
 */
export function recalibrateCharsPerToken(
	samples: CalibrationSample[],
): Record<string, number> {
	const usable = samples.filter((s) => s.estimated > 0 && s.reported > 0);
	const byProvider = new Map<string, CalibrationSample[]>();
	for (const s of usable) {
		const rows = byProvider.get(s.provider) ?? [];
		rows.push(s);
		byProvider.set(s.provider, rows);
	}

	const result: Record<string, number> = {};
	for (const [provider, rows] of byProvider) {
		let sumEstSq = 0;
		let sumEstRep = 0;
		for (const s of rows) {
			sumEstSq += s.estimated * s.estimated;
			sumEstRep += s.estimated * s.reported;
		}
		if (sumEstRep <= 0) continue;
		result[provider] = (shippedConstant(provider) * sumEstSq) / sumEstRep;
	}
	return result;
}

/** Signed relative drift of one turn: (estimate − report) / report.
 * Positive = dilna over-counts; negative = dilna under-counts. */
export function turnDrift(estimated: number, reported: number): number | null {
	if (reported <= 0) return null;
	return (estimated - reported) / reported;
}

/** The library's flat constant, for callers that want to express a
 * calibration result as a factor over `chars/4`. */
export { LIBRARY_CHARS_PER_TOKEN };
