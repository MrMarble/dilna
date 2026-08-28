import type { Repo, UsageDailyPoint, UsageSummary } from "@dilna/shared";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { formatTokenCount } from "@/lib/tokens";
import { cn } from "@/lib/utils";

type Props = {
	repos: Repo[];
	onBack: () => void;
};

type RangeOption = { label: string; days: number | "all" };

const RANGE_OPTIONS: RangeOption[] = [
	{ label: "7d", days: 7 },
	{ label: "30d", days: 30 },
	{ label: "90d", days: 90 },
	{ label: "All", days: "all" },
];

function formatUsd(n: number): string {
	if (n === 0) return "$0.00";
	// Cheap/cached-heavy turns routinely cost a fraction of a cent — 4 decimals
	// alone rounds anything under $0.0001 down to a misleading "$0.0000",
	// hiding real spend. Widen precision as the value gets smaller instead.
	if (n < 0.000001) return "<$0.000001";
	if (n < 0.0001) return `$${n.toFixed(6)}`;
	if (n < 0.01) return `$${n.toFixed(4)}`;
	return `$${n.toFixed(2)}`;
}

/**
 * Cost/token dashboard, sourced from `usage_events` (one row per turn — see
 * `SessionManager.accumulateSessionUsage`). Separate data path from the
 * per-session `UsageBadge`/`useSessionUsage`: this reflects historical spend
 * across every repo and survives session deletion, that reflects only the
 * currently open session's live tokens-only total.
 *
 * Only records usage from the point this feature shipped — there's no
 * backfill source for cost/cache data from turns that already happened.
 */
export function MetricsPage({ repos, onBack }: Props) {
	const [days, setDays] = useState<number | "all">(30);
	const [summary, setSummary] = useState<UsageSummary | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		api.usage
			.summary(days)
			.then(({ summary }) => {
				if (!cancelled) setSummary(summary);
			})
			.catch((e) => {
				if (!cancelled) {
					setError(e instanceof Error ? e.message : "failed to load usage");
				}
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [days]);

	const repoNameById = Object.fromEntries(repos.map((r) => [r.id, r.slug]));
	const isEmpty = summary !== null && summary.daily.length === 0;

	return (
		<div className="flex flex-1 flex-col overflow-y-auto">
			<header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
				<Button variant="ghost" size="icon" onClick={onBack} title="Back">
					<ArrowLeft className="size-4" />
				</Button>
				<h1 className="font-semibold tracking-tight">Usage &amp; cost</h1>
				<div className="ml-auto flex items-center gap-1">
					{RANGE_OPTIONS.map((opt) => (
						<Button
							key={opt.label}
							variant={days === opt.days ? "default" : "outline"}
							size="sm"
							onClick={() => setDays(opt.days)}
						>
							{opt.label}
						</Button>
					))}
				</div>
			</header>

			<div className="mx-auto w-full max-w-4xl flex-1 space-y-6 p-6">
				{error && (
					<p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
						{error}
					</p>
				)}

				{!error && loading && !summary && (
					<p className="text-sm text-muted-foreground">Loading…</p>
				)}

				{!error && isEmpty && (
					<p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
						No usage recorded yet — data appears here after your next agent
						turn.
					</p>
				)}

				{summary && !isEmpty && (
					<>
						<SummaryCards summary={summary} />
						<DailyUsageChart daily={summary.daily} />
						<RepoBreakdownTable summary={summary} repoNameById={repoNameById} />
					</>
				)}
			</div>
		</div>
	);
}

function StatCard({
	label,
	value,
	sub,
}: {
	label: string;
	value: string;
	sub?: string;
}) {
	return (
		<div className="rounded-xl border border-border bg-card p-4 shadow-sm">
			<p className="text-xs text-muted-foreground">{label}</p>
			<p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">
				{value}
			</p>
			{sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
		</div>
	);
}

function SummaryCards({ summary }: { summary: UsageSummary }) {
	const { totals } = summary;
	const totalTokens = totals.inputTokens + totals.outputTokens;
	const cacheTokens = totals.cacheReadTokens + totals.cacheWriteTokens;
	return (
		<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
			<StatCard label="Total cost" value={formatUsd(totals.costUsd)} />
			<StatCard
				label="Tokens"
				value={formatTokenCount(totalTokens)}
				sub={`${formatTokenCount(totals.inputTokens)} in · ${formatTokenCount(totals.outputTokens)} out`}
			/>
			<StatCard
				label="Cache tokens"
				value={formatTokenCount(cacheTokens)}
				sub={`${formatTokenCount(totals.cacheReadTokens)} read · ${formatTokenCount(totals.cacheWriteTokens)} write`}
			/>
		</div>
	);
}

/**
 * Daily cost bar chart — hand-rolled inline SVG (no chart dependency in this
 * app). Single series/single hue (`--primary`, the app's existing accent
 * token), so the multi-hue categorical palette rules don't apply here.
 * Hover reveals the day's exact cost/token breakdown above the chart rather
 * than a cursor-following tooltip, keeping bars as comfortably-sized hit
 * targets on touch too.
 */
function DailyUsageChart({ daily }: { daily: UsageDailyPoint[] }) {
	const [hoverIndex, setHoverIndex] = useState<number | null>(null);
	const width = 100;
	const height = 40;
	const maxCost = Math.max(...daily.map((d) => d.costUsd), 0.000001);
	const barWidth = width / daily.length;
	const gap = Math.min(barWidth * 0.25, 0.6);
	const hovered = hoverIndex !== null ? daily[hoverIndex] : null;

	return (
		<div className="rounded-xl border border-border bg-card p-4 shadow-sm">
			<div className="mb-2 flex items-baseline justify-between text-xs text-muted-foreground">
				<span>Daily cost</span>
				<span className="tabular-nums">
					{hovered
						? `${hovered.date} · ${formatUsd(hovered.costUsd)} · ${formatTokenCount(hovered.inputTokens + hovered.outputTokens)} tok`
						: `${daily[0]?.date} – ${daily[daily.length - 1]?.date}`}
				</span>
			</div>
			<svg
				viewBox={`0 0 ${width} ${height}`}
				preserveAspectRatio="none"
				className="h-32 w-full overflow-visible"
				role="img"
				aria-label="Daily cost over the selected range"
			>
				{daily.map((d, i) => {
					const barHeight = Math.max(
						(d.costUsd / maxCost) * height,
						d.costUsd > 0 ? 1 : 0,
					);
					const x = i * barWidth + gap / 2;
					const w = Math.max(barWidth - gap, 0.1);
					return (
						// biome-ignore lint/a11y/noStaticElementInteractions: hover-only chart bar (mouse), decorative — not keyboard-actionable
						<rect
							key={d.date}
							x={x}
							y={height - barHeight}
							width={w}
							height={barHeight}
							rx={Math.min(w * 0.3, 1)}
							fill="var(--primary)"
							opacity={hoverIndex === null || hoverIndex === i ? 1 : 0.35}
							onMouseEnter={() => setHoverIndex(i)}
							onMouseLeave={() => setHoverIndex(null)}
						/>
					);
				})}
			</svg>
		</div>
	);
}

function RepoBreakdownTable({
	summary,
	repoNameById,
}: {
	summary: UsageSummary;
	repoNameById: Record<string, string>;
}) {
	return (
		<div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
			<table className="w-full text-sm">
				<thead>
					<tr className="border-b border-border text-left text-xs text-muted-foreground">
						<th className="px-4 py-2 font-medium">Repo</th>
						<th className="px-4 py-2 text-right font-medium">Tokens</th>
						<th className="px-4 py-2 text-right font-medium">Cost</th>
					</tr>
				</thead>
				<tbody>
					{summary.byRepo.map((r, i) => (
						<tr
							key={r.repoId}
							className={cn("tabular-nums", i > 0 && "border-t border-border")}
						>
							<td className="px-4 py-2 font-mono text-xs">
								{repoNameById[r.repoId] ?? `${r.repoId.slice(0, 8)}… (deleted)`}
							</td>
							<td className="px-4 py-2 text-right">
								{formatTokenCount(r.inputTokens + r.outputTokens)}
							</td>
							<td className="px-4 py-2 text-right">{formatUsd(r.costUsd)}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
