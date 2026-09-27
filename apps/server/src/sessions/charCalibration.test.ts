import { describe, expect, it } from "vitest";
import {
	type CalibrationSample,
	recalibrateCharsPerToken,
	turnDrift,
} from "./charCalibration";

/**
 * The measurement's math, verified without an Agent or an LLM: samples
 * generated from a known true constant must be recovered by the
 * least-squares fit, so running the script over a real instance's
 * `usage_events` rows yields the constant that actually minimises error.
 */
describe("recalibrateCharsPerToken", () => {
	/** Synthesize samples as a real instance would produce them: dilna
	 * estimates chars/`shipped`, the provider counts chars/`true`. */
	function samples(
		provider: string,
		shipped: number,
		truth: number,
		charSizes: number[],
	): CalibrationSample[] {
		return charSizes.map((chars) => ({
			provider,
			estimated: Math.round(chars / shipped),
			reported: Math.round(chars / truth),
		}));
	}

	it("recovers the true constant from generated samples", () => {
		// dilna shipped 3.8 for anthropic; suppose the tokenizer really packs
		// chars/3.0. The fit must land on ~3.0, not on the shipped value.
		const result = recalibrateCharsPerToken(
			samples(
				"anthropic",
				3.8,
				3.0,
				[20_000, 55_000, 120_000, 400_000, 1_500_000],
			),
		);
		expect(result["anthropic"]).toBeCloseTo(3.0, 1);
	});

	it("lands on the shipped constant when the estimator is already honest", () => {
		const result = recalibrateCharsPerToken(
			samples("zai", 3.6, 3.6, [30_000, 90_000, 300_000]),
		);
		expect(result["zai"]).toBeCloseTo(3.6, 1);
	});

	it("keeps providers apart — one drifted provider doesn't move another", () => {
		const result = recalibrateCharsPerToken([
			...samples("anthropic", 3.8, 3.0, [100_000, 500_000]),
			...samples("deepseek", 3.5, 3.5, [100_000, 500_000]),
		]);
		expect(result["anthropic"]).toBeCloseTo(3.0, 1);
		expect(result["deepseek"]).toBeCloseTo(3.5, 1);
	});

	it("skips unusable samples and providers with none", () => {
		const result = recalibrateCharsPerToken([
			{ provider: "anthropic", estimated: 0, reported: 1000 },
			{ provider: "anthropic", estimated: 500, reported: 0 },
			// moonshotai has no samples at all.
		]);
		expect(result).toEqual({});
	});
});

describe("turnDrift", () => {
	it("is signed: positive over-count, negative under-count", () => {
		expect(turnDrift(1250, 1000)).toBeCloseTo(0.25, 6);
		expect(turnDrift(750, 1000)).toBeCloseTo(-0.25, 6);
		expect(turnDrift(1000, 1000)).toBe(0);
	});

	it("is null when there is nothing to compare against", () => {
		expect(turnDrift(500, 0)).toBeNull();
	});
});
