import type { RateLimitWindow, RateLimitWindowKind } from "@dilna/shared";

/** Display order + copy for the sidebar footer's two bars — UI labels only,
 * the domain model refers to these by `RateLimitWindowKind`. */
export const RATE_LIMIT_ORDER: RateLimitWindowKind[] = [
	"five_hour",
	"seven_day",
];

export const RATE_LIMIT_LABELS: Record<RateLimitWindowKind, string> = {
	five_hour: "5-hour",
	seven_day: "Weekly",
};

/** Neutral below 50%, yellow 50-80% (inclusive), red above 80% — per the
 * issue's acceptance criteria exactly. */
export function rateLimitBarColor(utilizationPct: number): string {
	if (utilizationPct > 80) return "bg-red-500";
	if (utilizationPct >= 50) return "bg-amber-500";
	return "bg-zinc-400 dark:bg-zinc-500";
}

/** True while `window`'s reset time is still in the future relative to
 * `nowMs`. The server already omits windows whose reset has passed from
 * whatever it last broadcast, but an open tab needs its own clock too — the
 * last broadcast could have arrived before `resetsAt` and nothing further
 * refreshes it once no Session is live (per the issue's "goes stale... once
 * its reset time has passed" requirement). */
export function isRateLimitWindowFresh(
	window: Pick<RateLimitWindow, "resetsAt">,
	nowMs: number,
): boolean {
	return window.resetsAt * 1000 > nowMs;
}

/** "2h 14m" / "42m" / "now" — for the hover tooltip's time-to-reset. */
export function formatTimeToReset(
	resetsAtSeconds: number,
	nowMs: number,
): string {
	const diffMs = resetsAtSeconds * 1000 - nowMs;
	if (diffMs <= 0) return "now";
	const totalMinutes = Math.round(diffMs / 60_000);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours === 0) return `${minutes}m`;
	return `${hours}h ${minutes}m`;
}

/** Full hover-tooltip text: exact percentage + time-to-reset. */
export function rateLimitTooltip(
	window: RateLimitWindow,
	nowMs: number,
): string {
	const pct = Math.round(window.utilizationPct);
	return `${RATE_LIMIT_LABELS[window.kind]}: ${pct}% used · resets in ${formatTimeToReset(window.resetsAt, nowMs)}`;
}
