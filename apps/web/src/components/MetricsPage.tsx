import type {
	BurnCheckCode,
	BurnFinding,
	BurnFindingSeverity,
	DiskUsage,
	Repo,
	UsageContextDrift,
	UsageDailyModelBreakdown,
	UsageDailyPoint,
	UsageModelBreakdown,
	UsagePurpose,
	UsageSessionBreakdown,
	UsageSummary,
	UsageToolBreakdown,
	UsageTotalsDetailed,
} from "@dilna/shared";
import { formatUsd } from "@dilna/shared";
import { ArrowLeft, HardDrive } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
	cacheHealthBarColor,
	cacheHealthTone,
	cacheHealthTooltip,
	formatHitRate,
} from "@/lib/cache-health";
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
	// Bumped when a burn finding's action resolves, so the card re-reads the
	// summary and cleared findings disappear immediately.
	const [actionNonce, setActionNonce] = useState(0);

	// biome-ignore lint/correctness/useExhaustiveDependencies: actionNonce is a deliberate re-fetch trigger — it is bumped when a burn finding's action resolves, and the effect must re-run to show the post-action summary even though it never reads the nonce itself.
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
	}, [days, actionNonce]);

	const repoNameById = Object.fromEntries(repos.map((r) => [r.id, r.slug]));
	const isEmpty = summary !== null && summary.daily.length === 0;

	return (
		<div className="flex flex-1 flex-col overflow-y-auto">
			<header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
				<Button
					variant="ghost"
					size="icon"
					onClick={onBack}
					title="Back"
					aria-label="Back"
				>
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
						<TokenCompositionChart totals={summary.totals} />
						<CachePanel summary={summary} repoNameById={repoNameById} />
						<BurnChecksCard
							findings={summary.burnFindings}
							repoNameById={repoNameById}
							onActionComplete={() => setActionNonce((n) => n + 1)}
						/>
						<ContextDriftCard
							drift={summary.contextDrift}
							repoNameById={repoNameById}
						/>
						<ToolUsageTable tools={summary.toolUsage} />
						<ModelBreakdownTable models={summary.byModel} />
						<RepoBreakdownTable summary={summary} repoNameById={repoNameById} />
						<TopSessionsTable
							sessions={summary.topSessions}
							repoNameById={repoNameById}
						/>
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
		<div className="rounded-xl border border-border bg-card p-4 shadow-card">
			<p className="text-xs text-muted-foreground">{label}</p>
			<p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">
				{value}
			</p>
			{sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
		</div>
	);
}

/** What the Total cost card calls each non-turn purpose. Exhaustive so a new
 * `UsagePurpose` has to be named here before it type-checks. */
const PURPOSE_LABELS: Record<Exclude<UsagePurpose, "turn">, string> = {
	judge: "scoring",
	subagent: "subagents",
};

function SummaryCards({ summary }: { summary: UsageSummary }) {
	const { totals } = summary;
	const totalTokens = totals.inputTokens + totals.outputTokens;
	const cacheTokens = totals.cacheReadTokens + totals.cacheWriteTokens;
	// Side spend — judge calls (ADR-0046), subagent runs (ADR-0053) — is real
	// spend and already in the totals; the card just says how much of it went
	// somewhere other than the Sessions' own turns.
	const side = summary.byPurpose
		.filter((p) => p.purpose !== "turn" && p.costUsd > 0)
		.sort((a, b) => b.costUsd - a.costUsd)
		.map(
			(p) =>
				`${formatUsd(p.costUsd)} on ${PURPOSE_LABELS[p.purpose as Exclude<UsagePurpose, "turn">]}`,
		);
	return (
		<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
			<StatCard
				label="Total cost"
				value={formatUsd(totals.costUsd)}
				sub={side.length > 0 ? `incl. ${side.join(" · ")}` : undefined}
			/>
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
		<div className="rounded-xl border border-border bg-card p-4 shadow-card">
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
 * Fixed slots from the app's `--chart-1`..`--chart-8` categorical palette
 * (see `DailyUsageChart`'s color-assignment doc comment) — assigned by fixed
 * order here rather than `assignSeriesColors`' hash-based slotting, since
 * these categories (unlike per-day models) are a known, unchanging set.
 *
 * Deliberately excludes cache read/write: in a healthy cache-reuse pattern
 * (the common case — the whole prior transcript re-sent and cache-hit each
 * turn) cache read alone routinely accounts for ~98% of raw token volume,
 * which in a linear stacked bar reduces input/output/reasoning to invisible
 * slivers even though they're the categories that actually vary with prompt
 * and response shape. The "Cache tokens" summary card above already covers
 * the cache-specific read-vs-write question this bar would otherwise
 * duplicate and drown out.
 */
const TOKEN_SEGMENTS = [
	{ key: "inputTokens", label: "Input", className: "bg-chart-1" },
	{ key: "outputTokens", label: "Output", className: "bg-chart-2" },
	{ key: "reasoningTokens", label: "Reasoning", className: "bg-chart-3" },
] as const satisfies {
	key: keyof UsageTotalsDetailed;
	label: string;
	className: string;
}[];

/**
 * Where non-cache tokens actually went — input/output/reasoning as a single
 * stacked bar, so the shape of what's actually being prompted/generated is
 * visible without cache read/write's usual dominance drowning it out (see
 * `TOKEN_SEGMENTS`'s doc comment).
 */
function TokenCompositionChart({ totals }: { totals: UsageTotalsDetailed }) {
	const total =
		totals.inputTokens + totals.outputTokens + totals.reasoningTokens;
	if (total === 0) return null;

	return (
		<div className="rounded-xl border border-border bg-card p-4 shadow-card">
			<div className="mb-3 text-xs text-muted-foreground">
				Token composition
			</div>
			<div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
				{TOKEN_SEGMENTS.map((seg) => {
					const value = totals[seg.key];
					if (value === 0) return null;
					return (
						<div
							key={seg.key}
							className={seg.className}
							style={{ width: `${(value / total) * 100}%` }}
							title={`${seg.label}: ${formatTokenCount(value)}`}
						/>
					);
				})}
			</div>
			<ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
				{TOKEN_SEGMENTS.map((seg) => {
					const value = totals[seg.key];
					return (
						<li
							key={seg.key}
							className="flex items-center gap-1.5 text-xs tabular-nums"
						>
							<span
								className={cn("size-2 shrink-0 rounded-full", seg.className)}
							/>
							<span className="text-muted-foreground">{seg.label}</span>
							<span className="ml-auto font-medium">
								{formatTokenCount(value)}
							</span>
							<span className="w-9 text-right text-muted-foreground">
								{total > 0 ? `${((value / total) * 100).toFixed(0)}%` : "0%"}
							</span>
						</li>
					);
				})}
			</ul>
		</div>
	);
}

/**
 * One row of a cache-rate breakdown table: label + colored hit rate, with
 * the raw components in the tooltip.
 */
type CacheRateRow = {
	key: string;
	label: string;
	rate: number | null;
	read: number;
	write: number;
	uncachedInput: number;
};

/**
 * Cache-health panel (issue #266) — the baseline instrument over
 * `usage_events`' cache columns, shipped before anything changes how dilna
 * builds a prompt so the effect is measured rather than asserted. Hit rate
 * = cache reads / (reads + writes + uncached input), computed server-side
 * per slice; this panel only reads it. Until this panel existed, a Session
 * paying a cache-write premium every turn looked identical to a healthy
 * cached one.
 *
 * Worth knowing while reading it: dilna's request prefix is byte-stable
 * across the turns of a *live* Session, so a healthy warm-Session rate is
 * expected — the write side of the ratio is what exposes cold starts (idle
 * kill, restart, post-compaction respawn).
 */
function CachePanel({
	summary,
	repoNameById,
}: {
	summary: UsageSummary;
	repoNameById: Record<string, string>;
}) {
	const { totals } = summary;
	// Rendered whenever any usage exists (the page already handles the truly
	// empty instance) — a provider that never reports cache tokens shows a
	// legitimate 0% here, and slices with no input-side tokens show "—".
	const rate = totals.cacheHitRate;
	const byRepo: CacheRateRow[] = summary.byRepo.map((r) => ({
		key: r.repoId,
		label: repoNameById[r.repoId] ?? `${r.repoId.slice(0, 8)}… (deleted)`,
		rate: r.cacheHitRate,
		read: r.cacheReadTokens,
		write: r.cacheWriteTokens,
		uncachedInput: r.inputTokens,
	}));
	const byModel: CacheRateRow[] = summary.byModel.map((m) => ({
		key: `${m.provider}/${m.model}`,
		label: `${m.model} · ${m.provider}`,
		rate: m.cacheHitRate,
		read: m.cacheReadTokens,
		write: m.cacheWriteTokens,
		uncachedInput: m.inputTokens,
	}));
	const bySession: CacheRateRow[] = summary.topSessions.map((s) => ({
		key: s.sessionId,
		label: s.title ?? `deleted session ${s.sessionId.slice(0, 8)}…`,
		rate: s.cacheHitRate,
		read: s.cacheReadTokens,
		write: s.cacheWriteTokens,
		uncachedInput: s.inputTokens,
	}));

	return (
		<div className="rounded-xl border border-border bg-card p-4 shadow-card">
			<div className="mb-2 flex items-baseline justify-between text-xs text-muted-foreground">
				<span>Cache health</span>
				<span
					className="tabular-nums"
					title={cacheHealthTooltip(
						rate,
						totals.cacheReadTokens,
						totals.cacheWriteTokens,
						totals.inputTokens,
					)}
				>
					{formatTokenCount(totals.cacheReadTokens)} read ·{" "}
					{formatTokenCount(totals.cacheWriteTokens)} written ·{" "}
					{formatTokenCount(totals.inputTokens)} uncached in
				</span>
			</div>
			<div className="flex items-baseline gap-2">
				<span
					className={cn(
						"text-2xl font-semibold tabular-nums tracking-tight",
						cacheHealthTone(rate),
					)}
				>
					{formatHitRate(rate)}
				</span>
				<span className="text-xs text-muted-foreground">hit rate</span>
			</div>
			<CacheTrend daily={summary.daily} />
			<div className="mt-3 grid gap-x-6 gap-y-3 border-t border-border pt-3 sm:grid-cols-3">
				<CacheRateTable title="By repo" rows={byRepo} />
				<CacheRateTable title="By model" rows={byModel} />
				<CacheRateTable title="By session" rows={bySession} />
			</div>
		</div>
	);
}

/** Per-day trend: one bar per day, filled to the day's hit rate. Days with
 * nothing to measure render an empty slot (visible gap, hover explains why)
 * instead of a zero-height bar, which would read as a 0% day. */
function CacheTrend({ daily }: { daily: UsageDailyPoint[] }) {
	if (daily.length === 0) return null;
	return (
		<div className="mt-3 flex h-14 items-end gap-px">
			{daily.map((d) => (
				<div
					key={d.date}
					className="flex h-full min-w-0 flex-1 flex-col justify-end"
					title={cacheHealthTooltip(
						d.cacheHitRate,
						d.cacheReadTokens,
						d.cacheWriteTokens,
						d.inputTokens,
					)}
				>
					{d.cacheHitRate !== null && (
						<div
							className={cn(
								"w-full rounded-sm",
								cacheHealthBarColor(d.cacheHitRate),
							)}
							style={{ height: `${Math.max(d.cacheHitRate * 100, 2)}%` }}
						/>
					)}
				</div>
			))}
		</div>
	);
}

function CacheRateTable({
	title,
	rows,
}: {
	title: string;
	rows: CacheRateRow[];
}) {
	if (rows.length === 0) return null;
	return (
		<div>
			<div className="mb-1 text-xs text-muted-foreground">{title}</div>
			<ul className="flex flex-col gap-1">
				{rows.map((r) => (
					<li
						key={r.key}
						className="flex items-baseline justify-between gap-2 text-sm"
						title={cacheHealthTooltip(r.rate, r.read, r.write, r.uncachedInput)}
					>
						<span className="min-w-0 truncate">{r.label}</span>
						<span
							className={cn("shrink-0 tabular-nums", cacheHealthTone(r.rate))}
						>
							{formatHitRate(r.rate)}
						</span>
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * Context estimate drift (issue #270) — Sessions whose dilna-side context
 * estimate persistently disagrees with the provider's own report, the
 * calibration alarm for `PROVIDER_CHARS_PER_TOKEN`. Only Sessions past the
 * server-side threshold are listed (worst first), so the section is simply
 * absent while every estimator is honest. Under-counting (negative drift)
 * is the dangerous direction — compaction fires too late and the real
 * window can overflow before the meter says so — hence danger red for
 * negatives, amber for over-counting (which merely wastes context on early
 * compaction).
 */
/** Display label per burn check — exhaustive over `BurnCheckCode`, so a new
 * check added server-side fails to typecheck here until it's named (same
 * exhaustiveness trick as `sessionStream.ts`'s event-type map). */
const BURN_CHECK_LABELS: Record<BurnCheckCode, string> = {
	"session-overdepth": "Session overdepth",
	"cache-rehydration": "Cache rehydration",
	"model-overthinking": "Overthinking",
	"expensive-delegation": "Expensive delegation",
	"repo-unused-skill": "Unused skill",
	"unused-tool": "Unused tool",
};

/** What the $ column means per check, once priced and once when it renders
 * the em dash — the waste models differ (a premium, a rate × token sum, an
 * overspend; the fan-out shape deliberately carries no figure at all), and
 * the tooltip is where the column stays honest about that. */
const WASTE_HINTS: Record<BurnCheckCode, { priced: string; unpriced: string }> =
	{
		"session-overdepth": {
			priced: "Estimated waste vs the Session's own median turn",
			unpriced: "No catalog price for this model — no $ estimate",
		},
		"cache-rehydration": {
			priced: "Cache-write premium over a warm cache on the flagged re-writes",
			unpriced: "No catalog price for this model — no $ estimate",
		},
		"model-overthinking": {
			priced: "Flagged reasoning tokens at the model's plain output rate",
			unpriced: "No catalog price for this model — no $ estimate",
		},
		"expensive-delegation": {
			priced: "Judge overspend vs the turn it scored",
			unpriced:
				"Fan-out spend is real work, not waste — the total is in the evidence",
		},
		"repo-unused-skill": {
			priced:
				"Prompt-line carry at the model's uncached input rate — an upper bound",
			unpriced: "No catalog price for the models in range — no $ estimate",
		},
		"unused-tool": {
			priced:
				"Estimated waste of carrying the unused tool's schema on every observed turn",
			unpriced: "No catalog price for the models in range — no $ estimate",
		},
	};

const SEVERITY_BADGE: Record<BurnFindingSeverity, string> = {
	critical: "bg-danger/10 text-danger",
	warning: "bg-warning/10 text-warning",
	info: "bg-muted text-muted-foreground",
};

/**
 * The judgment layer over the spend every card above measures (issue #291):
 * burn findings computed entirely server-side (`sessions/burnFindings.ts`),
 * worst first, rendered from the shared `BurnFinding` shape only. A finding
 * may carry a server-declared `action` (ADR-0052): a one-click resolution
 * executed from the row, after which the summary is re-fetched (via
 * `onActionComplete`) so resolved findings disappear instead of lingering
 * until the next range switch. Empty reads as an explicit all-clear — an
 * absence of findings is a verdict, not missing data.
 */
function BurnChecksCard({
	findings,
	repoNameById,
	onActionComplete,
}: {
	findings: BurnFinding[];
	repoNameById: Record<string, string>;
	onActionComplete?: () => void;
}) {
	const [busyAction, setBusyAction] = useState<string | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);

	const runAction = async (finding: BurnFinding) => {
		const action = finding.action;
		if (action?.kind !== "disable-skill-for-repo" || finding.repoId == null)
			return;
		setBusyAction(actionKey(finding));
		setActionError(null);
		try {
			await api.skills.setEnabled(action.skillId, finding.repoId, false);
			onActionComplete?.();
		} catch (err) {
			setActionError(
				err instanceof Error ? err.message : "Failed to disable skill.",
			);
		} finally {
			setBusyAction(null);
		}
	};

	return (
		<div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
			<div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
				Burn checks — where tokens are being wasted
			</div>
			{findings.length === 0 ? (
				<p className="px-4 py-3 text-sm text-muted-foreground">
					All clear — nothing in this range is burning tokens out of proportion.
				</p>
			) : (
				<ul className="divide-y divide-border">
					{findings.map((f, i) => {
						const repo =
							f.repoId != null
								? (repoNameById[f.repoId] ??
									`${f.repoId.slice(0, 8)}… (deleted)`)
								: null;
						// Session findings fall back to the id; Repo-scoped ones have
						// no Session to name, so the server always sets a title for
						// them — "unknown" is a defensive last resort.
						const subject =
							f.title ??
							(f.sessionId != null
								? `deleted session ${f.sessionId.slice(0, 8)}…`
								: "unknown");
						return (
							<li
								// The server caps findings at ten in a stable worst-first order, but
								// check + Session is not a unique key: finding S has two shapes
								// (fan-out, judge) that can both flag one orchestrator.
								// biome-ignore lint/suspicious/noArrayIndexKey: the index only disambiguates that stable-list pair
								key={`${actionKey(f)}-${i}`}
								className="px-4 py-3"
							>
								<div className="flex items-center gap-2">
									<span
										className={cn(
											"shrink-0 rounded px-1.5 py-0.5 text-xs font-medium",
											SEVERITY_BADGE[f.severity],
										)}
									>
										{f.severity}
									</span>
									<span className="truncate font-medium">{subject}</span>
									{repo && (
										<span className="hidden font-mono text-xs text-muted-foreground sm:inline">
											{repo}
										</span>
									)}
									<span
										className="ml-auto shrink-0 text-sm font-medium tabular-nums"
										title={
											f.wasteUsd != null
												? WASTE_HINTS[f.check].priced
												: WASTE_HINTS[f.check].unpriced
										}
									>
										{f.wasteUsd != null ? `~${formatUsd(f.wasteUsd)}` : "—"}
									</span>
								</div>
								<p className="mt-1 text-xs text-muted-foreground">
									<span className="font-medium text-foreground">
										{BURN_CHECK_LABELS[f.check]}:
									</span>{" "}
									{f.evidence}
								</p>
								{f.action && (
									<div className="mt-2">
										<Button
											variant="outline"
											size="sm"
											disabled={busyAction != null}
											onClick={() => void runAction(f)}
										>
											{busyAction === actionKey(f)
												? "Disabling…"
												: f.action.kind === "disable-skill-for-repo"
													? `Disable "${f.action.skillName}" for this repo`
													: null}
										</Button>
									</div>
								)}
								{actionError && (
									<p className="mt-2 text-xs text-destructive">{actionError}</p>
								)}
							</li>
						);
					})}
				</ul>
			)}
			<p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
				Computed server-side from the same usage as every card above, scoped to
				the selected range; where an estimate comes from is on each finding's
				evidence line. A model with no price in the catalog yields a finding
				without a $ figure, never a guessed zero.
			</p>
		</div>
	);
}

/** Stable React key for a finding row — check + Session id, or check +
 * Repo + action target (two unused skills on one Repo are two rows). */
function actionKey(finding: BurnFinding): string {
	if (finding.sessionId != null) return `${finding.check}-${finding.sessionId}`;
	return `${finding.check}-${finding.repoId ?? ""}-${
		finding.action?.kind === "disable-skill-for-repo"
			? finding.action.skillId
			: ""
	}`;
}

function ContextDriftCard({
	drift,
	repoNameById,
}: {
	drift: UsageContextDrift[];
	repoNameById: Record<string, string>;
}) {
	if (drift.length === 0) return null;
	return (
		<div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
			<div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
				Context estimate drift — dilna vs provider
			</div>
			<table className="w-full text-sm">
				<thead>
					<tr className="border-b border-border text-left text-xs text-muted-foreground">
						<th className="px-4 py-2 font-medium">Session</th>
						<th className="px-4 py-2 font-medium">Repo</th>
						<th className="px-4 py-2 text-right font-medium">Drift</th>
						<th className="px-4 py-2 text-right font-medium">Turns</th>
					</tr>
				</thead>
				<tbody>
					{drift.map((d, i) => (
						<tr
							key={d.sessionId}
							className={cn("tabular-nums", i > 0 && "border-t border-border")}
						>
							<td className="max-w-64 truncate px-4 py-2">
								{d.title ?? `deleted session ${d.sessionId.slice(0, 8)}…`}
							</td>
							<td className="px-4 py-2 font-mono text-xs text-muted-foreground">
								{repoNameById[d.repoId] ?? `${d.repoId.slice(0, 8)}… (deleted)`}
							</td>
							<td
								className={cn(
									"px-4 py-2 text-right font-medium",
									d.driftPct < 0 ? "text-danger" : "text-warning",
								)}
								title={
									d.driftPct < 0
										? "dilna under-counts this Session's context — compaction may fire too late and the provider's real window can overflow"
										: "dilna over-counts this Session's context — compaction fires early and throws away context it didn't need to"
								}
							>
								{d.driftPct > 0 ? "+" : ""}
								{(d.driftPct * 100).toFixed(0)}%
							</td>
							<td className="px-4 py-2 text-right text-muted-foreground">
								{d.turns}
							</td>
						</tr>
					))}
				</tbody>
			</table>
			<p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
				Mean signed gap between dilna's context estimate and what the provider
				itself reported, per turn. Recalibrate charsPerTokenFor() once enough
				turns have accumulated (see scripts/measure-chars-per-token.ts).
			</p>
		</div>
	);
}

/**
 * What the Agent actually did over the selected range (issue #292), one row
 * per tool — plus one per skill loaded via `read_skill`, which is how a
 * skill's burn (its body entering context) becomes countable at all.
 * Computed server-side from the per-turn facts the pi adapter stamps at
 * turn end (`usage_events.tool_facts_json`); the web renders from the shared
 * type only. Hidden entirely while the range has no facts rows: the capture
 * is forward-only, so pre-feature turns mean an absent table, not a table
 * of zeros.
 */
function ToolUsageTable({ tools }: { tools: UsageToolBreakdown[] }) {
	if (tools.length === 0) return null;
	return (
		<div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
			<div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
				Tool &amp; skill usage
			</div>
			<table className="w-full text-sm">
				<thead>
					<tr className="border-b border-border text-left text-xs text-muted-foreground">
						<th className="px-4 py-2 font-medium">Tool / skill</th>
						<th className="px-4 py-2 text-right font-medium">Calls</th>
						<th className="px-4 py-2 text-right font-medium">Sessions</th>
					</tr>
				</thead>
				<tbody>
					{tools.map((t, i) => (
						<tr
							key={`${t.kind}:${t.name}`}
							className={cn("tabular-nums", i > 0 && "border-t border-border")}
						>
							<td className="px-4 py-2">
								<span className="font-mono text-xs">{t.name}</span>
								{t.kind === "skill" && (
									<span className="ml-1 text-xs text-muted-foreground">
										· skill
									</span>
								)}
							</td>
							<td className="px-4 py-2 text-right">{t.calls}</td>
							<td className="px-4 py-2 text-right">{t.sessions}</td>
						</tr>
					))}
				</tbody>
			</table>
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
		<div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
			<div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
				By model
			</div>
			<table className="w-full text-sm">
				<thead>
					<tr className="border-b border-border text-left text-xs text-muted-foreground">
						<th className="px-4 py-2 font-medium">Model</th>
						<th className="px-4 py-2 text-right font-medium">Cache eff.</th>
						<th className="px-4 py-2 text-right font-medium">Tokens</th>
						<th className="px-4 py-2 text-right font-medium">Cost</th>
						<th className="px-4 py-2 text-right font-medium">Cost / token</th>
						<th className="px-4 py-2 text-right font-medium">Cost / 1M</th>
					</tr>
				</thead>
				<tbody>
					{models.map((m, i) => {
						// Same denominator as the "Tokens" column (input+output) so the
						// rate math on this row stays consistent with what's displayed
						// — a blended rate, not a real input-vs-output split, since the
						// SDK only reports one combined costUsd per turn (see
						// usageStats.ts's doc comment).
						const tokens = m.inputTokens + m.outputTokens;
						const perToken = tokens > 0 ? m.costUsd / tokens : 0;
						return (
							<tr
								key={`${m.provider}/${m.model}`}
								className={cn(
									"tabular-nums",
									i > 0 && "border-t border-border",
								)}
							>
								<td className="px-4 py-2">
									<span className="font-mono text-xs">{m.model}</span>
									<span className="ml-1 text-xs text-muted-foreground">
										· {m.provider}
									</span>
								</td>
								<td
									className={cn(
										"px-4 py-2 text-right",
										cacheHealthTone(m.cacheHitRate),
									)}
									title={cacheHealthTooltip(
										m.cacheHitRate,
										m.cacheReadTokens,
										m.cacheWriteTokens,
										m.inputTokens,
									)}
								>
									{formatHitRate(m.cacheHitRate)}
								</td>
								<td className="px-4 py-2 text-right">
									{formatTokenCount(tokens)}
								</td>
								<td className="px-4 py-2 text-right">{formatUsd(m.costUsd)}</td>
								<td className="px-4 py-2 text-right text-muted-foreground">
									{tokens > 0 ? `~${formatUsd(perToken)}` : "—"}
								</td>
								<td className="px-4 py-2 text-right text-muted-foreground">
									{tokens > 0 ? `~${formatUsd(perToken * 1_000_000)}` : "—"}
								</td>
							</tr>
						);
					})}
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
		<div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
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
 * Highest-spending Sessions in range (server-side top-`TOP_SESSIONS_LIMIT`,
 * already sorted by cost). Deliberately survives Session deletion — see
 * `usageEvents`'s schema comment and `usageStats.ts`'s `getTopSessions`:
 * `title` is resolved against the live Session or, once deleted, its
 * `sessionArchive` row (ADR-0024), falling back to a short id only for the
 * rare pre-archive-feature row that has neither.
 */
function TopSessionsTable({
	sessions,
	repoNameById,
}: {
	sessions: UsageSessionBreakdown[];
	repoNameById: Record<string, string>;
}) {
	if (sessions.length === 0) return null;
	return (
		<div className="overflow-hidden rounded-xl border border-border bg-card shadow-card">
			<div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
				Top sessions
			</div>
			<table className="w-full text-sm">
				<thead>
					<tr className="border-b border-border text-left text-xs text-muted-foreground">
						<th className="px-4 py-2 font-medium">Session</th>
						<th className="px-4 py-2 font-medium">Repo</th>
						<th className="px-4 py-2 text-right font-medium">Tokens</th>
						<th className="px-4 py-2 text-right font-medium">Cost</th>
					</tr>
				</thead>
				<tbody>
					{sessions.map((s, i) => (
						<tr
							key={s.sessionId}
							className={cn("tabular-nums", i > 0 && "border-t border-border")}
						>
							<td className="max-w-64 truncate px-4 py-2">
								{s.title ?? `deleted session ${s.sessionId.slice(0, 8)}…`}
							</td>
							<td className="px-4 py-2 font-mono text-xs text-muted-foreground">
								{repoNameById[s.repoId] ?? `${s.repoId.slice(0, 8)}… (deleted)`}
							</td>
							<td className="px-4 py-2 text-right">
								{formatTokenCount(s.inputTokens + s.outputTokens)}
							</td>
							<td className="px-4 py-2 text-right">{formatUsd(s.costUsd)}</td>
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
				? "bg-warning"
				: "bg-primary";

	return (
		<div className="rounded-xl border border-border bg-card p-4 shadow-card">
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
