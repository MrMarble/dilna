import type {
	DiskUsage,
	Repo,
	UsageDailyModelBreakdown,
	UsageDailyPoint,
	UsageModelBreakdown,
	UsageSummary,
} from "@dilna/shared";
import { ArrowLeft, HardDrive } from "lucide-react";
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

/** Human-size bytes (base-1024) — "1.2 GB", "600 MB", "512 B". */
function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = n;
	let unit = -1;
	do {
		value /= 1024;
		unit++;
	} while (value >= 1024 && unit < units.length - 1);
	return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
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
				<h1 className="font-semibold tracking-tight">Metrics</h1>
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
						<DailyUsageChart
							daily={summary.daily}
							dailyByModel={summary.dailyByModel}
						/>
						<ModelBreakdownTable models={summary.byModel} />
						<RepoBreakdownTable summary={summary} repoNameById={repoNameById} />
					</>
				)}

				<DiskUsageCard />
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
 * Fixed categorical hue order (`--chart-1`..`--chart-8` in index.css) — see
 * the dataviz skill: assign colors by fixed slot order, validated for
 * CVD-safe adjacency/contrast against this app's card surface, never by
 * on-screen rank so a model keeps its color as the date range filter
 * changes which models are present.
 */
const SERIES_SLOTS = 8;

/** djb2 string hash, used only as the starting point for slot assignment below. */
function hashString(key: string): number {
	let hash = 5381;
	for (let i = 0; i < key.length; i++) {
		hash = (hash * 33) ^ key.charCodeAt(i);
	}
	return Math.abs(hash);
}

function modelKey(m: { provider: string; model: string }): string {
	return `${m.provider}/${m.model}`;
}

/**
 * Assigns each model a slot: hash to a starting slot, then linearly probe
 * to the next free one on collision. Keeps a given model's color stable
 * across re-renders (models are visited in a fixed alphabetical order) while
 * guaranteeing every model *currently in view* gets a distinct color — a
 * plain hash can (and did) collide two models onto the same hue with only
 * ~8 slots. Beyond 8 concurrently-visible models, slots wrap and repeat.
 */
function assignSeriesColors(keys: string[]): Map<string, number> {
	const used = new Set<number>();
	const map = new Map<string, number>();
	for (const key of [...keys].sort()) {
		let idx = hashString(key) % SERIES_SLOTS;
		for (let tries = 0; used.has(idx) && tries < SERIES_SLOTS; tries++) {
			idx = (idx + 1) % SERIES_SLOTS;
		}
		used.add(idx);
		map.set(key, idx);
	}
	return map;
}

/**
 * Daily cost bar chart — hand-rolled inline SVG (no chart dependency in
 * this app). Stacked per model/provider so relative usage across models is
 * visible per day, per the dataviz skill's categorical-color rules. Hover
 * reveals the day's exact cost/token breakdown, plus a per-model line-item
 * list ("one tooltip, every series"), above the chart rather than a
 * cursor-following tooltip, keeping bars as comfortably-sized hit targets
 * on touch too. A legend is always shown once >=2 models are present.
 */
function DailyUsageChart({
	daily,
	dailyByModel,
}: {
	daily: UsageDailyPoint[];
	dailyByModel: UsageDailyModelBreakdown[];
}) {
	const [hoverIndex, setHoverIndex] = useState<number | null>(null);
	const width = 100;
	const height = 40;
	const maxCost = Math.max(...daily.map((d) => d.costUsd), 0.000001);
	const barWidth = width / daily.length;
	const gap = Math.min(barWidth * 0.25, 0.6);
	// ~2px surface gap between stacked segments, in viewBox units (svg is
	// rendered at h-32 = 128px tall for a 40-unit viewBox).
	const segmentGap = (2 / 128) * height;
	const hovered = hoverIndex !== null ? daily[hoverIndex] : null;

	// Stable per-date model breakdown, sorted alphabetically so a model's
	// stack position (and thus reading order) doesn't jump between bars.
	const byDate = new Map<string, UsageDailyModelBreakdown[]>();
	for (const row of dailyByModel) {
		const rows = byDate.get(row.date) ?? [];
		rows.push(row);
		byDate.set(row.date, rows);
	}
	for (const rows of byDate.values()) {
		rows.sort((a, b) => modelKey(a).localeCompare(modelKey(b)));
	}

	const legendModels = Array.from(
		new Map(dailyByModel.map((m) => [modelKey(m), m])).values(),
	).sort((a, b) => modelKey(a).localeCompare(modelKey(b)));

	const colorSlots = assignSeriesColors(legendModels.map(modelKey));
	const colorVar = (m: { provider: string; model: string }) =>
		`var(--chart-${(colorSlots.get(modelKey(m)) ?? 0) + 1})`;

	const hoveredModels = hovered ? (byDate.get(hovered.date) ?? []) : [];

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
			{/* Reserve the row's height even when empty so hover doesn't shift layout. */}
			<div className="mb-1 flex min-h-[1.1rem] flex-wrap items-center justify-end gap-x-3 gap-y-0.5 text-[0.7rem] text-muted-foreground">
				{hoveredModels.map((m) => (
					<span
						key={modelKey(m)}
						className="inline-flex items-center gap-1 tabular-nums"
					>
						<span
							className="inline-block h-[2px] w-2.5 rounded-full"
							style={{ backgroundColor: colorVar(m) }}
						/>
						<span className="font-mono">{m.model}</span>
						<span className="font-medium text-foreground">
							{formatUsd(m.costUsd)}
						</span>
					</span>
				))}
			</div>
			<svg
				viewBox={`0 0 ${width} ${height}`}
				preserveAspectRatio="none"
				className="h-32 w-full overflow-visible"
				role="img"
				aria-label="Daily cost over the selected range, stacked by model"
			>
				{daily.map((d, i) => {
					const barHeight = Math.max(
						(d.costUsd / maxCost) * height,
						d.costUsd > 0 ? 1 : 0,
					);
					const x = i * barWidth + gap / 2;
					const w = Math.max(barWidth - gap, 0.1);
					const top = height - barHeight;
					const opacity = hoverIndex === null || hoverIndex === i ? 1 : 0.35;
					const segments = byDate.get(d.date) ?? [];

					if (segments.length === 0 || d.costUsd <= 0) {
						return (
							// biome-ignore lint/a11y/noStaticElementInteractions: hover-only chart bar (mouse), decorative — not keyboard-actionable
							<rect
								key={d.date}
								x={x}
								y={top}
								width={w}
								height={barHeight}
								rx={Math.min(w * 0.3, 1)}
								fill="var(--muted-foreground)"
								opacity={barHeight > 0 ? opacity * 0.3 : 0}
								onMouseEnter={() => setHoverIndex(i)}
								onMouseLeave={() => setHoverIndex(null)}
							/>
						);
					}

					let cursor = top;
					return (
						<g key={d.date}>
							{segments.map((seg, si) => {
								const segHeight = (seg.costUsd / d.costUsd) * barHeight;
								const isTop = si === 0;
								const isBottom = si === segments.length - 1;
								const y = cursor;
								cursor += segHeight;
								const halfGap = segmentGap / 2;
								const drawY = y + (isTop ? 0 : halfGap);
								const drawHeight = Math.max(
									segHeight - (isTop ? 0 : halfGap) - (isBottom ? 0 : halfGap),
									0.1,
								);
								return (
									// biome-ignore lint/a11y/noStaticElementInteractions: hover-only chart segment (mouse), decorative — not keyboard-actionable
									<rect
										key={modelKey(seg)}
										x={x}
										y={drawY}
										width={w}
										height={drawHeight}
										rx={isTop ? Math.min(w * 0.3, 1) : 0}
										fill={colorVar(seg)}
										opacity={opacity}
										onMouseEnter={() => setHoverIndex(i)}
										onMouseLeave={() => setHoverIndex(null)}
									/>
								);
							})}
						</g>
					);
				})}
			</svg>
			{legendModels.length > 1 && (
				<div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
					{legendModels.map((m) => (
						<span
							key={modelKey(m)}
							className="inline-flex items-center gap-1.5"
						>
							<span
								className="inline-block size-2 rounded-[2px]"
								style={{ backgroundColor: colorVar(m) }}
							/>
							<span className="font-mono">{m.model}</span>
						</span>
					))}
				</div>
			)}
		</div>
	);
}

/**
 * Per-model breakdown — the model/provider attribution that makes sense now
 * that the provider+model is web-configurable (a single instance can run
 * turns under several models over time). Each row is one `provider`/`model`
 * combination seen in `usage_events` over the selected range, sorted by cost
 * descending (already sorted server-side in `usageStats.ts`).
 */
function ModelBreakdownTable({ models }: { models: UsageModelBreakdown[] }) {
	if (models.length === 0) return null;
	return (
		<div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
			<div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
				By model
			</div>
			<table className="w-full text-sm">
				<thead>
					<tr className="border-b border-border text-left text-xs text-muted-foreground">
						<th className="px-4 py-2 font-medium">Model</th>
						<th className="px-4 py-2 text-right font-medium">Tokens</th>
						<th className="px-4 py-2 text-right font-medium">Cost</th>
					</tr>
				</thead>
				<tbody>
					{models.map((m, i) => (
						<tr
							key={`${m.provider}/${m.model}`}
							className={cn("tabular-nums", i > 0 && "border-t border-border")}
						>
							<td className="px-4 py-2">
								<span className="font-mono text-xs">{m.model}</span>
								<span className="ml-1 text-xs text-muted-foreground">
									· {m.provider}
								</span>
							</td>
							<td className="px-4 py-2 text-right">
								{formatTokenCount(m.inputTokens + m.outputTokens)}
							</td>
							<td className="px-4 py-2 text-right">{formatUsd(m.costUsd)}</td>
						</tr>
					))}
				</tbody>
			</table>
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

/**
 * Live filesystem capacity for the volume backing `DILNA_DATA_DIR` (read via
 * `fs.statfs` server-side — `api.usage.disk`). Shows used/total and a
 * utilization bar; the bar turns primary→amber→destructive as free space
 * crosses 50% / 85% used so a nearly-full disk (which stalls agent installs —
 * see ENOSPC) is visible before it actually fails. Fetches once on mount;
 * capacity changes slowly enough that a per-view refresh suffices.
 */
function DiskUsageCard() {
	const [disk, setDisk] = useState<DiskUsage | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		api.usage
			.disk()
			.then(({ disk: d }) => {
				if (!cancelled) setDisk(d);
			})
			.catch((e) => {
				if (!cancelled) {
					setError(
						e instanceof Error ? e.message : "failed to load disk usage",
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	if (error) return null;

	const usedBytes = disk ? disk.totalBytes - disk.freeBytes : 0;
	const usedPct = disk ? (usedBytes / disk.totalBytes) * 100 : 0;
	const barColor =
		usedPct >= 85
			? "bg-destructive"
			: usedPct >= 50
				? "bg-amber-500"
				: "bg-primary";

	return (
		<div className="rounded-xl border border-border bg-card p-4 shadow-sm">
			<div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
				<span className="flex items-center gap-1.5 font-medium">
					<HardDrive className="size-3.5" />
					Storage
				</span>
				<span className="tabular-nums">
					{disk
						? `${formatBytes(usedBytes)} of ${formatBytes(disk.totalBytes)} used`
						: "Loading…"}
				</span>
			</div>
			<div
				className="h-2 w-full overflow-hidden rounded-full bg-muted"
				role="progressbar"
				aria-label="Disk usage"
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={Math.round(usedPct)}
			>
				<div
					className={`h-full rounded-full transition-[background-color,width] ${barColor}`}
					style={{ width: `${usedPct}%` }}
				/>
			</div>
			<p className="mt-2 text-right text-xs text-muted-foreground tabular-nums">
				{disk ? `${formatBytes(disk.freeBytes)} free` : "\u00a0"}
			</p>
		</div>
	);
}
