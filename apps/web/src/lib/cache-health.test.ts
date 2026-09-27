import { describe, expect, it } from "vitest";
import {
	cacheHealthBarColor,
	cacheHealthTone,
	cacheHealthTooltip,
	formatHitRate,
} from "./cache-health";

describe("cacheHealthTone", () => {
	it("is danger below 50% — a Session mostly paying cache writes", () => {
		expect(cacheHealthTone(0.49)).toBe("text-danger");
		expect(cacheHealthTone(0.1)).toBe("text-danger");
	});

	it("is warning from 50% up to but not including 80%", () => {
		expect(cacheHealthTone(0.5)).toBe("text-warning");
		expect(cacheHealthTone(0.79)).toBe("text-warning");
	});

	it("is success at 80% and above — the expected warm-Session baseline", () => {
		expect(cacheHealthTone(0.8)).toBe("text-success");
		expect(cacheHealthTone(0.98)).toBe("text-success");
	});

	it("is muted when there is nothing to measure, never danger", () => {
		// An empty/new instance has no input-side tokens; null must not read
		// as "every turn was a cache miss".
		expect(cacheHealthTone(null)).toBe("text-muted-foreground");
	});
});

describe("formatHitRate", () => {
	it("renders one decimal, and a dash for nothing-to-measure", () => {
		expect(formatHitRate(0.842)).toBe("84.2%");
		expect(formatHitRate(1)).toBe("100.0%");
		expect(formatHitRate(0)).toBe("0.0%");
		expect(formatHitRate(null)).toBe("—");
	});
});

describe("cacheHealthBarColor", () => {
	it("mirrors the tone tiers with background tokens", () => {
		expect(cacheHealthBarColor(0.4)).toBe("bg-danger");
		expect(cacheHealthBarColor(0.6)).toBe("bg-warning");
		expect(cacheHealthBarColor(0.9)).toBe("bg-success");
		expect(cacheHealthBarColor(null)).toBe("bg-idle");
	});
});

describe("cacheHealthTooltip", () => {
	it("names the raw read/write/uncached components", () => {
		const tip = cacheHealthTooltip(0.9, 840_000, 80_000, 13_000);
		expect(tip).toContain("90.0% hit rate — healthy");
		expect(tip).toContain("840k");
		expect(tip).toContain("80k");
		expect(tip).toContain("13k");
	});

	it("calls out write-heavy slices as prefix misses, not just a low number", () => {
		expect(cacheHealthTooltip(0.2, 10, 700, 10)).toContain(
			"mostly cache writes",
		);
		expect(cacheHealthTooltip(0.6, 600, 200, 10)).toContain("partially cached");
	});

	it("says there is nothing to measure for a null rate", () => {
		expect(cacheHealthTooltip(null, 0, 0, 0)).toContain("Nothing to measure");
	});
});
