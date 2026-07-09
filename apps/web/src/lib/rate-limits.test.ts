import type { RateLimitWindow } from "@dilna/shared";
import { describe, expect, it } from "vitest";
import {
	formatTimeToReset,
	isRateLimitWindowFresh,
	rateLimitBarColor,
	rateLimitTooltip,
} from "./rate-limits";

describe("rateLimitBarColor", () => {
	it("is neutral below 50%", () => {
		expect(rateLimitBarColor(0)).toBe("bg-zinc-400 dark:bg-zinc-500");
		expect(rateLimitBarColor(49)).toBe("bg-zinc-400 dark:bg-zinc-500");
	});

	it("is yellow from 50% up to and including 80%", () => {
		expect(rateLimitBarColor(50)).toBe("bg-amber-500");
		expect(rateLimitBarColor(80)).toBe("bg-amber-500");
	});

	it("is red above 80%", () => {
		expect(rateLimitBarColor(81)).toBe("bg-red-500");
		expect(rateLimitBarColor(100)).toBe("bg-red-500");
	});
});

describe("isRateLimitWindowFresh", () => {
	it("is fresh while resetsAt is still in the future", () => {
		const nowMs = 1_000_000_000;
		expect(isRateLimitWindowFresh({ resetsAt: nowMs / 1000 + 1 }, nowMs)).toBe(
			true,
		);
	});

	it("goes stale once resetsAt has passed, even with no new data", () => {
		const nowMs = 1_000_000_000;
		expect(isRateLimitWindowFresh({ resetsAt: nowMs / 1000 - 1 }, nowMs)).toBe(
			false,
		);
	});
});

describe("formatTimeToReset", () => {
	it("formats sub-hour durations as minutes", () => {
		const nowMs = 0;
		expect(formatTimeToReset(42 * 60, nowMs)).toBe("42m");
	});

	it("formats hour+minute durations", () => {
		const nowMs = 0;
		expect(formatTimeToReset(2 * 3600 + 14 * 60, nowMs)).toBe("2h 14m");
	});

	it("reports 'now' once the reset time has passed", () => {
		expect(formatTimeToReset(-1, 0)).toBe("now");
	});
});

describe("rateLimitTooltip", () => {
	it("includes the exact percentage and time-to-reset", () => {
		const window: RateLimitWindow = {
			kind: "five_hour",
			utilizationPct: 37.4,
			resetsAt: 90 * 60,
		};
		expect(rateLimitTooltip(window, 0)).toBe(
			"5-hour: 37% used · resets in 1h 30m",
		);
	});
});
