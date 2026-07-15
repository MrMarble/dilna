import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
	freshRateLimitWindows,
	normalizeResetsAt,
	pullRateLimitsToWindows,
	type RateLimitSnapshot,
	toRateLimitWindow,
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

describe("toRateLimitWindow", () => {
	// Regression coverage for a real payload observed against a live OAuth
	// subscription account: `status: "allowed"` with no `utilization` field
	// at all, while the account was genuinely at 32% of the window. The SDK
	// only includes a number once usage crosses its own warning threshold,
	// so a missing value means "unknown", not "low" — an earlier version
	// defaulted it to 0, which froze the sidebar footer at 0% and let these
	// events overwrite real readings pulled via pullRateLimitsToWindows.
	it("drops an event that omits utilization instead of inventing 0", () => {
		const info: SDKRateLimitInfo = {
			status: "allowed",
			resetsAt: 1_783_614_000,
			rateLimitType: "five_hour",
		};
		expect(toRateLimitWindow(info)).toBeNull();
	});

	it("passes through a real utilization value when the SDK includes one", () => {
		const info: SDKRateLimitInfo = {
			status: "allowed_warning",
			resetsAt: 1_783_614_000,
			rateLimitType: "seven_day",
			utilization: 62,
		};
		expect(toRateLimitWindow(info)).toEqual({
			kind: "seven_day",
			snapshot: { utilizationPct: 62, resetsAt: 1_783_614_000 },
		});
	});

	it("ignores per-model/overage sub-variants out of scope for the two-bar UI", () => {
		const info: SDKRateLimitInfo = {
			status: "allowed",
			resetsAt: 1_783_614_000,
			rateLimitType: "seven_day_opus",
			utilization: 10,
		};
		expect(toRateLimitWindow(info)).toBeNull();
	});

	it("returns null when resetsAt is missing, since staleness can't be computed", () => {
		const info: SDKRateLimitInfo = {
			status: "allowed",
			rateLimitType: "five_hour",
			utilization: 10,
		};
		expect(toRateLimitWindow(info)).toBeNull();
	});
});

describe("pullRateLimitsToWindows", () => {
	// Mirrors a real response from the claude.ai OAuth usage endpoint
	// (probed against a live subscription account): resets_at is an ISO 8601
	// string here, not the push event's epoch number, and `utilization` is a
	// 0–1 fraction — a real 88% weekly window came back as 0.87..0.88, not
	// 87..88 — so this asserts the *100 conversion to a percentage.
	it("parses both windows from a real-shaped pull response, converting the 0-1 fraction to a percentage", () => {
		const windows = pullRateLimitsToWindows({
			five_hour: {
				utilization: 0.32,
				resets_at: "2026-07-09T21:20:00.235531+00:00",
			},
			seven_day: {
				utilization: 0.04,
				resets_at: "2026-07-16T16:00:00.235555+00:00",
			},
		});
		expect(windows).toEqual([
			{
				kind: "five_hour",
				snapshot: {
					utilizationPct: 32,
					resetsAt: Math.floor(
						Date.parse("2026-07-09T21:20:00.235531+00:00") / 1000,
					),
				},
			},
			{
				kind: "seven_day",
				snapshot: {
					utilizationPct: 4,
					resetsAt: Math.floor(
						Date.parse("2026-07-16T16:00:00.235555+00:00") / 1000,
					),
				},
			},
		]);
	});

	it("returns an empty list for a null rate_limits object (API-key auth)", () => {
		expect(pullRateLimitsToWindows(null)).toEqual([]);
	});

	it("skips a window with null fields without dropping the other one", () => {
		const windows = pullRateLimitsToWindows({
			five_hour: { utilization: null, resets_at: null },
			seven_day: { utilization: 0.12, resets_at: "2026-07-16T16:00:00Z" },
		});
		expect(windows).toHaveLength(1);
		expect(windows[0]?.kind).toBe("seven_day");
	});

	// The pull API is explicitly experimental upstream — an unparseable
	// resets_at must degrade to "window absent", never throw.
	it("skips a window whose resets_at fails to parse", () => {
		const windows = pullRateLimitsToWindows({
			five_hour: { utilization: 32, resets_at: "not-a-date" },
		});
		expect(windows).toEqual([]);
	});

	it("ignores windows missing entirely from the response", () => {
		expect(pullRateLimitsToWindows({})).toEqual([]);
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
