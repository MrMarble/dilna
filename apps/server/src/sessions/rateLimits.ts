import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { RateLimitWindow, RateLimitWindowKind } from "@dilna/shared";

/**
 * The subset of the claude.ai OAuth usage endpoint's response body
 * (`GET /api/oauth/usage`, see agents/claudeUsage.ts) that the two-bar
 * footer reads. The real response carries much more (per-model windows, a
 * `limits` array, extra-usage credit state); structural typing lets the
 * extra fields pass through ignored. Field spellings are the endpoint's
 * own (`resets_at` ISO-8601 string), which is also exactly what the old
 * Agent SDK pull returned — the SDK was proxying this endpoint.
 */
export type PulledRateLimits = {
	five_hour?: { utilization: number | null; resets_at: string | null } | null;
	seven_day?: { utilization: number | null; resets_at: string | null } | null;
} | null;

/** Last-known reading for one rate-limit window, as held by SessionManager. */
export type RateLimitSnapshot = {
	utilizationPct: number;
	/** Epoch seconds. */
	resetsAt: number;
};

/**
 * The Claude Agent SDK's `SDKRateLimitInfo.resetsAt` is typed as a bare
 * `number` with no documented unit (see
 * docs/research/claude-agent-sdk-usage-limits.md — the SDK's own
 * declarations don't say). dilna's own timestamps are epoch seconds
 * (`Session.createdAt` etc.), so this normalizes on ingest: a value too
 * large to plausibly be a seconds-epoch for any timeframe dilna cares about
 * is assumed to be a milliseconds-epoch and scaled down; anything else is
 * assumed to already be seconds.
 */
export function normalizeResetsAt(raw: number): number {
	return raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
}

/**
 * Parse one SDK `rate_limit_event` payload into dilna's window shape, or
 * `null` if it's not one of the two windows this UI shows (per-model/overage
 * sub-variants), is missing `resetsAt` (nothing to key staleness off of), or
 * is missing `utilization`.
 *
 * A missing `utilization` means "unknown", not "low": a live account probed
 * at a real 32% five-hour utilization still received `status: "allowed"`
 * events with no `utilization` field at all — the SDK only starts including
 * a number once usage crosses its own warning threshold. (An earlier version
 * defaulted the missing value to 0, which froze the footer at 0% for any
 * normally-used account.) The authoritative percentages instead come from
 * the pull path ({@link pullRateLimitsToWindows}); events without a number
 * are dropped here so they can't overwrite a real pulled reading with 0.
 */
export function toRateLimitWindow(
	info: SDKRateLimitInfo,
): { kind: RateLimitWindowKind; snapshot: RateLimitSnapshot } | null {
	const kind: RateLimitWindowKind | null =
		info.rateLimitType === "five_hour" || info.rateLimitType === "seven_day"
			? info.rateLimitType
			: null;
	if (kind === null || info.resetsAt === undefined) return null;
	if (info.utilization === undefined) return null;

	return {
		kind,
		snapshot: {
			utilizationPct: info.utilization,
			resetsAt: normalizeResetsAt(info.resetsAt),
		},
	};
}

/**
 * Parse the usage endpoint's window objects (see {@link PulledRateLimits})
 * into dilna's window shape. This is the primary source of utilization
 * numbers — unlike the push `rate_limit_event`, it always carries real
 * percentages for both windows (see toRateLimitWindow's doc comment).
 *
 * The endpoint is undocumented (replicated from the CLI's own /usage fetch,
 * ADR-0015), so this parses defensively: `null`/absent windows, null fields,
 * or an unparseable `resets_at` (an ISO 8601 string here, unlike the push
 * event's epoch number) just drop that window rather than throwing — worst
 * case the footer degrades to absent, it never crashes a session.
 */
export function pullRateLimitsToWindows(
	rateLimits: PulledRateLimits,
): { kind: RateLimitWindowKind; snapshot: RateLimitSnapshot }[] {
	if (!rateLimits) return [];
	const out: { kind: RateLimitWindowKind; snapshot: RateLimitSnapshot }[] = [];
	for (const kind of ["five_hour", "seven_day"] as const) {
		const window = rateLimits[kind];
		if (!window || typeof window.utilization !== "number") continue;
		if (typeof window.resets_at !== "string") continue;
		const resetsAtMs = Date.parse(window.resets_at);
		if (Number.isNaN(resetsAtMs)) continue;
		out.push({
			kind,
			snapshot: {
				utilizationPct: window.utilization,
				resetsAt: Math.floor(resetsAtMs / 1000),
			},
		});
	}
	return out;
}

/**
 * Build the `SessionListEvent`-ready window list from last-known rate-limit
 * state, computing staleness at read time rather than storing a "stale" flag
 * that would need active invalidation. A window whose `resetsAt` has already
 * passed is omitted entirely (not served with a frozen percentage) — once no
 * live Session refreshes it, it simply drops out of the emitted list on the
 * next read. Per ADR/issue scope, nothing re-triggers this on a timer; it's
 * recomputed whenever a broadcast happens or a new subscriber snapshots.
 */
export function freshRateLimitWindows(
	state: ReadonlyMap<RateLimitWindowKind, RateLimitSnapshot>,
	nowSeconds: number,
): RateLimitWindow[] {
	const windows: RateLimitWindow[] = [];
	for (const [kind, snapshot] of state) {
		if (snapshot.resetsAt <= nowSeconds) continue;
		windows.push({
			kind,
			utilizationPct: snapshot.utilizationPct,
			resetsAt: snapshot.resetsAt,
		});
	}
	return windows;
}
