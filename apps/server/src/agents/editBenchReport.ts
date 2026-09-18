import type { BenchmarkRun } from "./editBenchRunner";

/**
 * Reporting for the edit-tool A/B harness (issue #138, item 1).
 *
 * A single run's numbers mean nothing on their own — session output tokens
 * vary by tens of percent between identical runs. What the harness needs to
 * show is a *distribution* per arm, so the comparison function here works on
 * a set of runs, not one, and reports a median alongside the spread.
 *
 * Pure, so it's testable without spending a cent on API calls.
 */

export type ArmSummary = {
	/** How many runs this arm contributed. */
	runs: number;
	/** Median output tokens across runs — the headline number. Median rather
	 * than mean because a single runaway turn skews a mean badly and there
	 * are never enough runs for that to average out. */
	medianOutputTokens: number;
	minOutputTokens: number;
	maxOutputTokens: number;
	/** Fraction of runs that produced exactly the expected file, 0–1. */
	successRate: number;
	/** Total edit retries across all runs. */
	totalRetries: number;
	/** Total edit failures across all runs. */
	totalFailures: number;
};

export type ArmComparison = {
	baseline: ArmSummary;
	candidate: ArmSummary;
	/** Percent change in median output tokens, candidate vs baseline.
	 * Negative means the candidate spent fewer tokens. `null` when the
	 * baseline median is 0, where a percentage is meaningless. */
	outputTokenChangePct: number | null;
};

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
		: (sorted[mid] as number);
}

export function summarizeArm(runs: BenchmarkRun[]): ArmSummary {
	const tokens = runs.map((run) => run.outputTokens);
	return {
		runs: runs.length,
		medianOutputTokens: median(tokens),
		minOutputTokens: tokens.length ? Math.min(...tokens) : 0,
		maxOutputTokens: tokens.length ? Math.max(...tokens) : 0,
		successRate: runs.length
			? runs.filter((run) => run.success).length / runs.length
			: 0,
		totalRetries: runs.reduce((sum, run) => sum + run.edits.retries, 0),
		totalFailures: runs.reduce((sum, run) => sum + run.edits.failures, 0),
	};
}

export function compareArms(
	baseline: BenchmarkRun[],
	candidate: BenchmarkRun[],
): ArmComparison {
	const base = summarizeArm(baseline);
	const cand = summarizeArm(candidate);
	return {
		baseline: base,
		candidate: cand,
		outputTokenChangePct:
			base.medianOutputTokens === 0
				? null
				: ((cand.medianOutputTokens - base.medianOutputTokens) /
						base.medianOutputTokens) *
					100,
	};
}

/** Render a comparison as the plain-text block the CLI prints — and, more to
 * the point, as what gets pasted into the ticket as the evidence. */
export function formatComparison(
	comparison: ArmComparison,
	labels: { baseline: string; candidate: string },
): string {
	const { baseline, candidate, outputTokenChangePct } = comparison;
	const pct =
		outputTokenChangePct === null
			? "n/a"
			: `${outputTokenChangePct >= 0 ? "+" : ""}${outputTokenChangePct.toFixed(1)}%`;
	const arm = (label: string, s: ArmSummary) =>
		[
			`  ${label}`,
			`    runs:            ${s.runs}`,
			`    output tokens:   median ${s.medianOutputTokens} (min ${s.minOutputTokens}, max ${s.maxOutputTokens})`,
			`    success rate:    ${(s.successRate * 100).toFixed(0)}%`,
			`    edit failures:   ${s.totalFailures}`,
			`    edit retries:    ${s.totalRetries}`,
		].join("\n");

	return [
		"Edit-tool benchmark",
		arm(labels.baseline, baseline),
		arm(labels.candidate, candidate),
		`  median output tokens: ${pct} (${labels.candidate} vs ${labels.baseline})`,
	].join("\n");
}
