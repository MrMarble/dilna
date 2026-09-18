import { describe, expect, it } from "vitest";
import { compareArms, formatComparison, summarizeArm } from "./editBenchReport";
import type { BenchmarkRun } from "./editBenchRunner";

function run(
	outputTokens: number,
	opts: { success?: boolean; retries?: number; failures?: number } = {},
): BenchmarkRun {
	return {
		sessionId: `s-${outputTokens}`,
		actualText: "",
		outputTokens,
		inputTokens: 1000,
		success: opts.success ?? true,
		edits: {
			attempts: 1 + (opts.retries ?? 0),
			failures: opts.failures ?? 0,
			retries: opts.retries ?? 0,
			filesTouched: 1,
		},
	};
}

describe("summarizeArm", () => {
	it("reports the median, not the mean, so one runaway run doesn't skew it", () => {
		// The outlier pushes the mean to 6000; the median stays 300.
		const summary = summarizeArm([run(200), run(300), run(400), run(23_100)]);

		expect(summary.medianOutputTokens).toBe(350);
		expect(summary.minOutputTokens).toBe(200);
		expect(summary.maxOutputTokens).toBe(23_100);
	});

	it("counts success rate and totals retries and failures across runs", () => {
		const summary = summarizeArm([
			run(100, { success: true }),
			run(100, { success: false, retries: 2, failures: 2 }),
			run(100, { success: true, retries: 1, failures: 1 }),
			run(100, { success: true }),
		]);

		expect(summary.runs).toBe(4);
		expect(summary.successRate).toBe(0.75);
		expect(summary.totalRetries).toBe(3);
		expect(summary.totalFailures).toBe(3);
	});

	it("handles an empty arm without dividing by zero", () => {
		const summary = summarizeArm([]);

		expect(summary.runs).toBe(0);
		expect(summary.medianOutputTokens).toBe(0);
		expect(summary.successRate).toBe(0);
	});
});

describe("compareArms", () => {
	it("reports the candidate's token change as a signed percentage", () => {
		const baseline = [run(1000), run(1000), run(1000)];
		const candidate = [run(400), run(400), run(400)];

		const comparison = compareArms(baseline, candidate);

		expect(comparison.outputTokenChangePct).toBeCloseTo(-60, 5);
	});

	it("returns null for the percentage when the baseline spent no tokens", () => {
		const comparison = compareArms([run(0)], [run(100)]);

		expect(comparison.outputTokenChangePct).toBeNull();
	});
});

describe("formatComparison", () => {
	it("renders both arms and the token delta in one block", () => {
		const text = formatComparison(compareArms([run(1000)], [run(400)]), {
			baseline: "str_replace",
			candidate: "hashline",
		});

		expect(text).toContain("str_replace");
		expect(text).toContain("hashline");
		expect(text).toContain("median 1000");
		expect(text).toContain("median 400");
		expect(text).toContain("-60.0%");
	});

	it("shows n/a rather than a bogus number when the delta is undefined", () => {
		const text = formatComparison(compareArms([run(0)], [run(100)]), {
			baseline: "a",
			candidate: "b",
		});

		expect(text).toContain("n/a");
	});
});
