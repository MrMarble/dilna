import type { RateLimitWindow, RateLimitWindowKind } from "@dilna/shared";

/**
 * Last-known reading for one rate-limit window, as held by SessionManager.
 * Nothing under `pi.ts` currently produces new readings (see this module's
 * former `toRateLimitWindow`/`pullRateLimitsToWindows`, deleted alongside
 * `claude.ts`/`claudeUsage.ts` — both were claude.ai-OAuth-specific, and
 * OAuth is dropped entirely for every provider under the pi-stack
 * migration). `getRateLimits`/`freshRateLimitWindows` are kept so a
 * previously-recorded reading (from before this migration) still serves
 * correctly until it goes stale — not a redesign of usage reporting, just
 * what's left once the only data source is gone.
 */
export type RateLimitSnapshot = {
	utilizationPct: number;
	/** Epoch seconds. */
	resetsAt: number;
};

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
