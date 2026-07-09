import { describe, expect, it } from "vitest";
import {
	freshRateLimitWindows,
	normalizeResetsAt,
	type RateLimitSnapshot,
} from "./rateLimits";

describe("normalizeResetsAt", () => {
	it("passes through a plausible seconds-epoch unchanged", () => {
		const seconds = 1_780_000_000; // ~2026, well under the ms threshold
		expect(normalizeResetsAt(seconds)).toBe(seconds);
	});

	it("scales down a milliseconds-epoch to seconds", () => {
		const ms = 1_780_000_000_000;
		expect(normalizeResetsAt(ms)).toBe(1_780_000_000);
	});

	it("floors fractional input", () => {
		expect(normalizeResetsAt(1_780_000_000.7)).toBe(1_780_000_000);
	});
});

describe("freshRateLimitWindows", () => {
	it("returns windows whose reset time is still in the future", () => {
		const now = 1_000_000;
		const state = new Map<string, RateLimitSnapshot>([
			["five_hour", { utilizationPct: 42, resetsAt: now + 3600 }],
			["seven_day", { utilizationPct: 12, resetsAt: now + 604_800 }],
		]) as ReadonlyMap<"five_hour" | "seven_day", RateLimitSnapshot>;

		const windows = freshRateLimitWindows(state, now);
		expect(windows).toHaveLength(2);
		expect(windows.find((w) => w.kind === "five_hour")?.utilizationPct).toBe(
			42,
		);
	});

	it("omits a window whose reset time has already passed, rather than freezing it", () => {
		const now = 1_000_000;
		const state = new Map<string, RateLimitSnapshot>([
			["five_hour", { utilizationPct: 99, resetsAt: now - 1 }],
			["seven_day", { utilizationPct: 12, resetsAt: now + 604_800 }],
		]) as ReadonlyMap<"five_hour" | "seven_day", RateLimitSnapshot>;

		const windows = freshRateLimitWindows(state, now);
		expect(windows).toHaveLength(1);
		expect(windows[0]?.kind).toBe("seven_day");
	});

	it("omits a window whose reset time is exactly now", () => {
		const now = 1_000_000;
		const state = new Map<string, RateLimitSnapshot>([
			["five_hour", { utilizationPct: 50, resetsAt: now }],
		]) as ReadonlyMap<"five_hour" | "seven_day", RateLimitSnapshot>;

		expect(freshRateLimitWindows(state, now)).toHaveLength(0);
	});

	it("returns an empty array when nothing has ever been reported", () => {
		const state = new Map<string, RateLimitSnapshot>() as ReadonlyMap<
			"five_hour" | "seven_day",
			RateLimitSnapshot
		>;
		expect(freshRateLimitWindows(state, 1_000_000)).toEqual([]);
	});
});
