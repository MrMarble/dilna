import {
	DEFAULT_SCORE_THRESHOLD,
	type LlmConfig,
	type ScoreMetric,
	type TurnScore,
} from "@dilna/shared";
import { Check, ChevronDown, ChevronRight, Gauge, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * Output scoring UI (issue #251, ADR-0046): a Score button on each finished
 * assistant turn, and the scores it has collected shown beneath it.
 *
 * Scores are not stream state — they only change when *this* tab asks for
 * one — so they live in a plain hook next to the chat rather than in
 * `chatReducer`.
 */

const METRIC_LABELS: Record<ScoreMetric, string> = {
	criteria: "Criteria",
	relevancy: "Relevancy",
};

const METRIC_HINTS: Record<ScoreMetric, string> = {
	criteria: "Score the turn against criteria you write.",
	relevancy: "How much of the reply addresses what was asked.",
};

/** A Session's turn scores, loaded once per Session and appended to as the
 * user scores turns. Returns them grouped by `turnId` for the rows. */
export function useTurnScores(sessionId: string) {
	const [scores, setScores] = useState<TurnScore[]>([]);

	useEffect(() => {
		let cancelled = false;
		setScores([]);
		api.sessions
			.scores(sessionId)
			.then(({ scores }) => {
				if (!cancelled) setScores(scores);
			})
			.catch(() => {
				// Non-fatal: the chat renders without scores, and a new one still
				// lands via `add`.
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	const add = useCallback((score: TurnScore) => {
		setScores((prev) => [...prev, score]);
	}, []);

	const byTurn = new Map<string, TurnScore[]>();
	for (const s of scores) {
		const list = byTurn.get(s.turnId);
		if (list) list.push(s);
		else byTurn.set(s.turnId, [s]);
	}
	return { byTurn, add };
}

/** The scores collected on one turn, each a chip that expands to its reason. */
export function TurnScoreList({ scores }: { scores: TurnScore[] }) {
	if (scores.length === 0) return null;
	return (
		<div className="mt-1 flex flex-col gap-1">
			{scores.map((s) => (
				<TurnScoreChip key={s.id} score={s} />
			))}
		</div>
	);
}

function TurnScoreChip({ score }: { score: TurnScore }) {
	const [expanded, setExpanded] = useState(false);
	return (
		<div className="text-xs text-muted-foreground">
			<button
				type="button"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
				className="inline-flex items-center gap-1.5 rounded-md border border-border/60 px-2 py-0.5 transition-colors hover:text-foreground"
			>
				{expanded ? (
					<ChevronDown className="size-3" />
				) : (
					<ChevronRight className="size-3" />
				)}
				<Gauge className="size-3" />
				<span>{METRIC_LABELS[score.metric]}</span>
				<span className="font-medium tabular-nums text-foreground">
					{score.score.toFixed(2)}
				</span>
				<span
					className={cn(
						"inline-flex items-center gap-0.5",
						score.passed
							? "text-green-600 dark:text-green-400"
							: "text-destructive",
					)}
				>
					{score.passed ? (
						<Check className="size-3" />
					) : (
						<X className="size-3" />
					)}
					{score.passed ? "pass" : "fail"}
				</span>
			</button>
			{expanded && (
				<div className="mt-1 space-y-1 rounded-md border border-border/60 bg-muted/20 px-2.5 py-1.5">
					<p className="whitespace-pre-wrap text-foreground">{score.reason}</p>
					{score.criteria && (
						<p className="whitespace-pre-wrap">
							<span className="font-medium">Criteria:</span> {score.criteria}
						</p>
					)}
					<p>
						Judged by {score.provider}/{score.model} · threshold{" "}
						{score.threshold.toFixed(2)}
					</p>
				</div>
			)}
		</div>
	);
}

/** `"provider/model"` — the judge `<select>`'s option value. */
function judgeKey(provider: string, model: string): string {
	return `${provider}/${model}`;
}

/**
 * Icon button that opens the score dialog for one turn. The judge defaults to
 * the Session's own model; any model of a provider with a configured key can
 * be picked instead (cross-provider judging).
 */
export function ScoreTurnButton({
	sessionId,
	turnId,
	sessionProvider,
	sessionModel,
	onScored,
	className,
}: {
	sessionId: string;
	turnId: string;
	sessionProvider?: string | null;
	sessionModel?: string | null;
	onScored: (score: TurnScore) => void;
	className?: string;
}) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button
				type="button"
				onClick={() => setOpen(true)}
				title="Score this turn"
				aria-label="Score this turn"
				className={cn(
					"rounded-md p-1 text-muted-foreground transition-[background-color,color,scale] hover:bg-accent hover:text-foreground active:scale-90 active:bg-accent",
					className,
				)}
			>
				<Gauge className="size-3.5" />
			</button>
			{open && (
				<ScoreTurnDialog
					open={open}
					onOpenChange={setOpen}
					sessionId={sessionId}
					turnId={turnId}
					defaultJudge={
						sessionProvider && sessionModel
							? judgeKey(sessionProvider, sessionModel)
							: ""
					}
					onScored={onScored}
				/>
			)}
		</>
	);
}

function ScoreTurnDialog({
	open,
	onOpenChange,
	sessionId,
	turnId,
	defaultJudge,
	onScored,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sessionId: string;
	turnId: string;
	defaultJudge: string;
	onScored: (score: TurnScore) => void;
}) {
	const [metric, setMetric] = useState<ScoreMetric>("criteria");
	const [criteria, setCriteria] = useState("");
	const [threshold, setThreshold] = useState(String(DEFAULT_SCORE_THRESHOLD));
	const [judge, setJudge] = useState(defaultJudge);
	const [config, setConfig] = useState<LlmConfig | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		api.config
			.get()
			.then(setConfig)
			.catch(() => {
				// The Session's own model stays selectable without the catalog.
			});
	}, []);

	const judgeOptions: { provider: string; model: string; label: string }[] = [];
	if (config) {
		for (const [provider, models] of Object.entries(config.modelsByProvider)) {
			if (!config.apiKeysConfigured[provider]) continue;
			for (const m of models) {
				judgeOptions.push({ provider, model: m.id, label: m.name });
			}
		}
	}
	const hasDefaultOption =
		defaultJudge !== "" &&
		!judgeOptions.some((o) => judgeKey(o.provider, o.model) === defaultJudge);

	const thresholdValue = Number(threshold);
	const thresholdValid =
		threshold.trim() !== "" &&
		Number.isFinite(thresholdValue) &&
		thresholdValue >= 0 &&
		thresholdValue <= 1;
	const canSubmit =
		!submitting &&
		thresholdValid &&
		(metric !== "criteria" || criteria.trim() !== "");

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!canSubmit) return;
		setSubmitting(true);
		setError(null);
		// Only name a judge when it differs from the Session's own model, so the
		// server's default resolution stays the one source for "the Session's
		// model".
		const override =
			judge && judge !== defaultJudge
				? judgeOptions.find((o) => judgeKey(o.provider, o.model) === judge)
				: undefined;
		try {
			const { score } = await api.sessions.scoreTurn(sessionId, turnId, {
				metric,
				criteria: metric === "criteria" ? criteria.trim() : undefined,
				threshold: thresholdValue,
				provider: override?.provider,
				model: override?.model,
			});
			onScored(score);
			onOpenChange(false);
		} catch (err) {
			setError(err instanceof Error ? err.message : "scoring failed");
		} finally {
			setSubmitting(false);
		}
	}

	const selectClass =
		"h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm transition-[color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Score this turn</DialogTitle>
					<DialogDescription>
						A judge model reads the turn and returns a 0–1 score with its
						reasoning. This spends tokens on the judge's provider.
					</DialogDescription>
				</DialogHeader>
				{/* `noValidate`: the threshold is range-checked in `canSubmit`, and native
				    step validation rejects in-range values like 0.55 over float error. */}
				<form onSubmit={handleSubmit} noValidate className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="score-metric">Metric</Label>
						<select
							id="score-metric"
							value={metric}
							onChange={(e) => setMetric(e.target.value as ScoreMetric)}
							disabled={submitting}
							className={selectClass}
						>
							{(Object.keys(METRIC_LABELS) as ScoreMetric[]).map((m) => (
								<option key={m} value={m}>
									{METRIC_LABELS[m]}
								</option>
							))}
						</select>
						<p className="text-xs text-muted-foreground">
							{METRIC_HINTS[metric]}
						</p>
					</div>
					{metric === "criteria" && (
						<div className="space-y-1.5">
							<Label htmlFor="score-criteria">Criteria</Label>
							<textarea
								id="score-criteria"
								value={criteria}
								onChange={(e) => setCriteria(e.target.value)}
								disabled={submitting}
								rows={4}
								maxLength={4000}
								placeholder="e.g. Verified the fix by running the tests, and explained the root cause."
								className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							/>
						</div>
					)}
					<div className="space-y-1.5">
						<Label htmlFor="score-judge">Judge model</Label>
						<select
							id="score-judge"
							value={judge}
							onChange={(e) => setJudge(e.target.value)}
							disabled={submitting}
							className={selectClass}
						>
							{defaultJudge === "" && (
								<option value="">Session's model (current default)</option>
							)}
							{hasDefaultOption && (
								<option value={defaultJudge}>
									{defaultJudge} (this Session)
								</option>
							)}
							{judgeOptions.map((o) => {
								const key = judgeKey(o.provider, o.model);
								return (
									<option key={key} value={key}>
										{o.provider} / {o.label}
										{key === defaultJudge ? " (this Session)" : ""}
									</option>
								);
							})}
						</select>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="score-threshold">Pass threshold (0–1)</Label>
						<Input
							id="score-threshold"
							type="number"
							min={0}
							max={1}
							step={0.05}
							value={threshold}
							onChange={(e) => setThreshold(e.target.value)}
							disabled={submitting}
						/>
					</div>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<DialogFooter>
						<Button type="submit" disabled={!canSubmit}>
							{submitting ? "Scoring…" : "Score"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
