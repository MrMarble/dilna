import type { SessionBurnTurn, UsagePurpose } from "@dilna/shared";
import { formatUsd } from "@dilna/shared";
import { ChevronsDownUp, Gavel, type LucideIcon, Split } from "lucide-react";
import { useSessionBurnTimeline } from "@/hooks/useSessionBurnTimeline";
import { contextUsageBarColor } from "@/lib/context-usage";
import { formatTokenCount } from "@/lib/tokens";
import { cn } from "@/lib/utils";

/**
 * The Session's burn timeline (issue #293) — the "why did this Session cost
 * what it cost" view, one row per `usage_events` row across the Session's
 * life: a token-composition bar (input / output / cache read+write /
 * reasoning) with the turn's cost, a context-occupancy strip per turn
 * (provider-reported solid, dilna's estimate striped as a fallback), and
 * markers for compactions and judge calls. Facts and numbers only — the
 * transcript itself covers content.
 *
 * Rendered as a vertical, oldest-first list rather than a horizontal chart
 * on purpose: this lives in the w-80 context panel, where a per-turn
 * x-axis becomes unreadable past a couple of dozen turns, while the list
 * scrolls through hundreds. Read top-to-bottom, the occupancy strips trace
 * the same line a chart would — rise per turn, cliff at a compaction.
 */
export function BurnTimeline({ sessionId }: { sessionId: string }) {
	const turns = useSessionBurnTimeline(sessionId);
	if (!turns) return null;

	if (turns.length === 0) {
		return (
			<p className="text-sm text-muted-foreground">
				No burn recorded yet — cost and context show up here after the Session's
				first turn completes.
			</p>
		);
	}

	const turnRows = turns.filter((t) => t.purpose === "turn");
	const rowTokenTotal = (t: SessionBurnTurn) =>
		SEGMENTS.reduce((sum, seg) => sum + seg.value(t), 0);
	const maxRowTokens = Math.max(
		...turnRows.map(rowTokenTotal),
		1, // all-zero rows still render a (muted, empty) bar
	);
	const totalCost = turns.reduce((sum, t) => sum + t.costUsd, 0);

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-baseline justify-between text-xs text-muted-foreground">
				<span>
					{turnRows.length} {turnRows.length === 1 ? "turn" : "turns"}
				</span>
				<span className="font-mono tabular-nums">{formatUsd(totalCost)}</span>
			</div>
			{/* Same four segments as each row's bar. */}
			<ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
				{SEGMENTS.map((seg) => (
					<li key={seg.label} className="flex items-center gap-1">
						<span className={cn("size-1.5 rounded-full", seg.className)} />
						{seg.label}
					</li>
				))}
			</ul>
			<ul className="flex flex-col">
				{turns.map((t, i) =>
					t.purpose !== "turn" ? (
						// biome-ignore lint/suspicious/noArrayIndexKey: rows carry no ids and the list is rebuilt wholesale per fetch (never reordered in place), so the position suffix is stable where the timestamp alone could collide (two side calls in one second).
						<SideCallRow key={`${t.purpose}-${t.at}-${i}`} turn={t} />
					) : (
						<TurnRow
							key={t.turn ?? `unnumbered-${t.at}`}
							turn={t}
							maxRowTokens={maxRowTokens}
						/>
					),
				)}
			</ul>
		</div>
	);
}

/**
 * One bar segment — label, colour, and the row fields it aggregates. The
 * single enumeration the legend, each row's bar, and the max scaling all
 * read, so a token field can't drift out of position against its colour.
 */
const SEGMENTS = [
	{
		label: "Input",
		className: "bg-chart-1",
		value: (t: SessionBurnTurn) => t.inputTokens,
	},
	{
		label: "Output",
		className: "bg-chart-2",
		value: (t: SessionBurnTurn) => t.outputTokens,
	},
	{
		// Cache read and write share a slot: their split is the Metrics cache
		// panel's question, not this timeline's.
		label: "Cache",
		className: "bg-chart-4",
		value: (t: SessionBurnTurn) => t.cacheReadTokens + t.cacheWriteTokens,
	},
	{
		label: "Reasoning",
		className: "bg-chart-3",
		value: (t: SessionBurnTurn) => t.reasoningTokens,
	},
] as const;

function formatRowDate(epochSeconds: number) {
	return new Date(epochSeconds * 1000).toLocaleString([], {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function TurnRow({
	turn,
	maxRowTokens,
}: {
	turn: SessionBurnTurn;
	maxRowTokens: number;
}) {
	return (
		<li
			className="flex flex-col gap-1 rounded-md px-1 py-1.5"
			title={`Turn ${turn.turn} ended ${formatRowDate(turn.at)}`}
		>
			<div className="flex items-center gap-2 text-xs">
				<span className="shrink-0 font-mono tabular-nums text-muted-foreground">
					#{turn.turn}
				</span>
				{turn.compacted && (
					<span
						className="flex shrink-0 items-center gap-0.5 rounded-full bg-warning/10 px-1.5 py-px text-warning"
						title="Compaction — the Session's summary now stands in for history through this turn"
					>
						<ChevronsDownUp className="size-3" aria-hidden />
						compacted
					</span>
				)}
				<span className="ml-auto shrink-0 font-mono tabular-nums">
					{formatUsd(turn.costUsd)}
				</span>
			</div>
			{/* Scaled to the busiest turn of the Session, so row heights compare
			    against each other — what "burned hotter when" is the question
			    this answers. */}
			<div className="h-2 w-full overflow-hidden rounded-full bg-muted">
				<div className="flex h-full w-full">
					{SEGMENTS.map((seg) => {
						const tokens = seg.value(turn);
						if (tokens === 0) return null;
						return (
							<div
								key={seg.label}
								className={seg.className}
								style={{ width: `${(tokens / maxRowTokens) * 100}%` }}
								title={`${seg.label}: ${formatTokenCount(tokens)}`}
							/>
						);
					})}
				</div>
			</div>
			<OccupancyStrip turn={turn} />
		</li>
	);
}

/**
 * Per-turn context occupancy on the shared 0→window scale — the
 * provider-reported figure where the turn has one (solid), dilna's own
 * estimate where it doesn't (striped + "~… est.", the same
 * estimated-vs-reported visual language as the context meter above). When a
 * turn carries *both* figures (the spec's "estimate alongside"), the
 * estimate is drawn as a tick at its own position on the same scale, so
 * per-turn drift between the two readings is visible here and not only in
 * Metrics' aggregate drift list. Rows missing both figures (pre-#267
 * history) render no strip; neither stamp is ever read as zero.
 */
function OccupancyStrip({ turn }: { turn: SessionBurnTurn }) {
	const { contextWindow } = turn;
	const reported = turn.providerContextTokens;
	const estimated = turn.estimatedContextTokens;
	// The headline figure — the provider's report when the turn has one,
	// dilna's estimate when it doesn't. Null only when the row carries
	// neither stamp (pre-#267 history): nothing to draw.
	const headline = reported !== null ? reported : estimated;
	if (contextWindow === null || contextWindow <= 0 || headline === null) {
		return null;
	}
	// Percent of the raw window, not the compaction trigger the live meter
	// scales against (that needs the reserve figure, which isn't per-row data)
	// — a few points conservative, which is the right direction for a
	// quick-read color; the exact token figure sits right next to it.
	const pct = (tokens: number) =>
		Math.max(0, Math.min(100, (tokens / contextWindow) * 100));
	const estimatedOnly = reported === null;
	const title = estimatedOnly
		? `Context this turn — ~${formatTokenCount(headline)}, dilna's estimate (the provider hasn't reported)`
		: estimated === null
			? `Context this turn — ${formatTokenCount(headline)} reported by the provider`
			: `Context this turn — provider reported ${formatTokenCount(headline)}, dilna's estimate ${formatTokenCount(estimated)}`;
	return (
		<div className="flex items-center gap-2" title={title}>
			<div className="relative h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
				<div
					className={cn(
						"h-full rounded-full",
						contextUsageBarColor(pct(headline)),
					)}
					style={{
						width: `${pct(headline)}%`,
						...(estimatedOnly
							? {
									// Stripes distinguish an estimated occupancy from the
									// solid reported one, matching the live meter.
									backgroundImage:
										"repeating-linear-gradient(135deg, rgba(255,255,255,0.4) 0 2px, transparent 2px 4px)",
								}
							: undefined),
					}}
				/>
				{reported !== null && estimated !== null && (
					<span
						className="absolute inset-y-0 w-0.5 bg-foreground/70"
						style={{ left: `${pct(estimated)}%` }}
						title={`dilna's estimate: ${formatTokenCount(estimated)}`}
					/>
				)}
			</div>
			<span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
				{estimatedOnly && "~"}
				{formatTokenCount(headline)} ctx{estimatedOnly && " est."}
			</span>
		</div>
	);
}

/** How each non-turn row reads in the timeline. Exhaustive over
 * `UsagePurpose` so a new purpose can't silently render as a turn. */
const SIDE_CALLS: Record<
	Exclude<UsagePurpose, "turn">,
	{ label: string; title: string; icon: LucideIcon }
> = {
	judge: {
		label: "Judge call",
		title: "Judge call (output scoring, ADR-0046)",
		icon: Gavel,
	},
	subagent: {
		label: "Subagent",
		title: "Subagent run (read-only `task` delegation, ADR-0053)",
		icon: Split,
	},
};

/**
 * A side call — a judge call (ADR-0046) or a subagent run (ADR-0053) —
 * between the turns it belongs between: real spend, so it's in the timeline,
 * but not a turn: no bar, no ordinal.
 */
function SideCallRow({ turn }: { turn: SessionBurnTurn }) {
	if (turn.purpose === "turn") return null;
	const { label, title, icon: Icon } = SIDE_CALLS[turn.purpose];
	return (
		<li
			className="flex items-center gap-1.5 py-0.5 pl-1 text-xs text-muted-foreground"
			title={`${title} — ${formatRowDate(turn.at)}`}
		>
			<Icon className="size-3 shrink-0" aria-hidden />
			<span>{label}</span>
			<span className="ml-auto shrink-0 font-mono tabular-nums">
				{formatUsd(turn.costUsd)}
			</span>
		</li>
	);
}
