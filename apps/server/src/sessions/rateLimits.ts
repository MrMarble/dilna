import type { RateLimitWindow, RateLimitWindowKind } from "@dilna/shared";

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
