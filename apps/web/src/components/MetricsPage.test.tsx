import type { UsageSummary } from "@dilna/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MetricsPage } from "@/components/MetricsPage";
import { expectEveryButtonNamed } from "@/test/accessible-name";
import type { PartialApi } from "@/test/api-mock";

const ZERO_TOTALS = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	reasoningTokens: 0,
	costUsd: 0,
	cacheHitRate: null,
};

let nextSummary: UsageSummary = {
	totals: { ...ZERO_TOTALS },
	daily: [],
	dailyByModel: [],
	byRepo: [],
	byModel: [],
	topSessions: [],
	byPurpose: [],
	contextDrift: [],
	burnFindings: [],
	toolUsage: [],
};

vi.mock("@/api/client", () => ({
	api: {
		usage: {
			summary: async () => ({ summary: nextSummary }),
			disk: async () => ({
				disk: { totalBytes: 10_000, freeBytes: 4_000 },
			}),
		},
	} satisfies PartialApi,
}));

describe("MetricsPage", () => {
	it("shows an empty state when there's no usage yet", async () => {
		nextSummary = {
			totals: { ...ZERO_TOTALS },
			daily: [],
			dailyByModel: [],
			byRepo: [],
			byModel: [],
			topSessions: [],
			byPurpose: [],
			burnFindings: [],
			toolUsage: [],
			contextDrift: [],
		};
		render(<MetricsPage repos={[]} onBack={() => {}} />);
		expect(
			await screen.findByText(/no usage recorded yet/i),
		).toBeInTheDocument();
	});

	it("renders totals, daily chart, and repo breakdown once usage exists", async () => {
		nextSummary = {
			totals: {
				...ZERO_TOTALS,
				inputTokens: 1000,
				outputTokens: 500,
				costUsd: 1.2345,
			},
			daily: [
				{
					date: "2026-08-27",
					...ZERO_TOTALS,
					inputTokens: 600,
					outputTokens: 300,
					costUsd: 0.7,
				},
				{
					date: "2026-08-28",
					...ZERO_TOTALS,
					inputTokens: 400,
					outputTokens: 200,
					costUsd: 0.5345,
				},
			],
			dailyByModel: [
				{
					date: "2026-08-27",
					provider: "anthropic",
					model: "claude-opus-5",
					...ZERO_TOTALS,
					inputTokens: 600,
					outputTokens: 300,
					costUsd: 0.7,
				},
				{
					date: "2026-08-28",
					provider: "anthropic",
					model: "claude-opus-5",
					...ZERO_TOTALS,
					inputTokens: 250,
					outputTokens: 100,
					costUsd: 0.3345,
				},
				{
					date: "2026-08-28",
					provider: "deepseek",
					model: "deepseek-v4-pro",
					...ZERO_TOTALS,
					inputTokens: 150,
					outputTokens: 100,
					costUsd: 0.2,
				},
			],
			byRepo: [
				{
					repoId: "repo-1",
					...ZERO_TOTALS,
					inputTokens: 1000,
					outputTokens: 500,
					costUsd: 1.2345,
				},
			],
			byModel: [],
			topSessions: [
				{
					sessionId: "session-1",
					repoId: "repo-1",
					title: "Fix the flaky test",
					...ZERO_TOTALS,
					inputTokens: 1000,
					outputTokens: 500,
					costUsd: 1.2345,
				},
			],
			byPurpose: [],
			burnFindings: [],
			toolUsage: [],
			contextDrift: [],
		};
		render(
			<MetricsPage
				repos={[
					{
						id: "repo-1",
						slug: "my-repo",
						path: "/tmp/my-repo",
						defaultBranch: "main",
						remoteUrl: "https://example.com/my-repo.git",
						createdAt: 0,
					},
				]}
				onBack={() => {}}
			/>,
		);

		// Total cost card, the single repo's breakdown row, and the single
		// session's row all show $1.23 (same underlying total).
		expect(await screen.findAllByText("$1.23")).toHaveLength(3);
		// Appears in both the repo breakdown row and the top-sessions row.
		expect(screen.getAllByText("my-repo").length).toBeGreaterThan(0);
		expect(screen.getAllByText("Fix the flaky test").length).toBeGreaterThan(0);

		// Legend lists every model present in the stacked daily chart.
		expect(screen.getAllByText("claude-opus-5").length).toBeGreaterThan(0);
		expect(screen.getAllByText("deepseek-v4-pro").length).toBeGreaterThan(0);
	});

	it("renders the cache panel with per-slice hit rates (issue #266)", async () => {
		nextSummary = {
			totals: {
				...ZERO_TOTALS,
				inputTokens: 1000,
				cacheReadTokens: 8000,
				cacheWriteTokens: 500,
				cacheHitRate: 8000 / 9500,
			},
			daily: [
				{
					date: "2026-08-27",
					...ZERO_TOTALS,
					inputTokens: 600,
					cacheReadTokens: 5400,
					cacheHitRate: 0.9,
				},
				{
					date: "2026-08-28",
					...ZERO_TOTALS,
					inputTokens: 400,
					cacheReadTokens: 200,
					cacheHitRate: 0.3333,
				},
			],
			dailyByModel: [],
			byRepo: [
				{
					repoId: "repo-1",
					...ZERO_TOTALS,
					inputTokens: 1000,
					cacheReadTokens: 8000,
					cacheWriteTokens: 500,
					cacheHitRate: 8000 / 9500,
				},
			],
			byModel: [
				{
					provider: "anthropic",
					model: "claude-opus-5",
					...ZERO_TOTALS,
					inputTokens: 600,
					cacheReadTokens: 7000,
					cacheWriteTokens: 400,
					cacheHitRate: 0.9,
				},
				{
					provider: "deepseek",
					model: "deepseek-v4-pro",
					...ZERO_TOTALS,
					inputTokens: 100,
					cacheReadTokens: 50,
					cacheWriteTokens: 900,
					cacheHitRate: 0.05,
				},
			],
			topSessions: [
				{
					sessionId: "session-1",
					repoId: "repo-1",
					title: "Fix the flaky test",
					...ZERO_TOTALS,
					inputTokens: 600,
					cacheReadTokens: 100,
					cacheWriteTokens: 500,
					cacheHitRate: 0.1428,
				},
				{
					sessionId: "session-2",
					repoId: "repo-1",
					title: "Cache-cold session",
					...ZERO_TOTALS,
					cacheHitRate: null,
				},
			],
			byPurpose: [],
			burnFindings: [],
			toolUsage: [],
			contextDrift: [],
		};
		render(
			<MetricsPage
				repos={[
					{
						id: "repo-1",
						slug: "my-repo",
						path: "/tmp/my-repo",
						defaultBranch: "main",
						remoteUrl: "https://example.com/my-repo.git",
						createdAt: 0,
					},
				]}
				onBack={() => {}}
			/>,
		);

		// Headline hit rate, one decimal, from the pooled totals — shown both
		// in the headline and the By-repo row.
		expect((await screen.findAllByText("84.2%")).length).toBe(2);
		expect(screen.getByText("hit rate")).toBeInTheDocument();

		// The three per-slice tables render: repo (named), model (cache
		// efficiency also joins the By-model table), session.
		expect(screen.getByText("Cache health")).toBeInTheDocument();
		expect(screen.getByText("By repo")).toBeInTheDocument();
		expect(screen.getAllByText("By model").length).toBe(2);
		expect(screen.getByText("By session")).toBeInTheDocument();
		expect(screen.getAllByText("90.0%").length).toBeGreaterThanOrEqual(1);

		// A write-heavy session is visually distinguishable from a healthy
		// one — same number styling, different semantic tone.
		const coldRow = screen.getByText("14.3%");
		expect(coldRow.className).toContain("text-danger");
		const healthyRow = screen.getAllByText("84.2%")[0];
		expect(healthyRow).toBeDefined();
		expect(healthyRow?.className).toContain("text-success");

		// Nothing-to-measure slices read as an em dash, never 0%.
		expect(screen.getByText("—")).toBeInTheDocument();
	});

	it("flags Sessions whose context estimate drifts past the threshold (issue #270)", async () => {
		nextSummary = {
			totals: { ...ZERO_TOTALS },
			daily: [
				{
					date: "2026-08-27",
					...ZERO_TOTALS,
					inputTokens: 500,
					costUsd: 0.01,
				},
			],
			dailyByModel: [],
			byRepo: [],
			byModel: [],
			topSessions: [],
			byPurpose: [],
			contextDrift: [
				{
					sessionId: "s-over",
					repoId: "repo-1",
					title: "Over-counting session",
					driftPct: 0.42,
					turns: 12,
				},
				{
					sessionId: "s-under",
					repoId: "repo-1",
					title: "Under-counting session",
					driftPct: -0.61,
					turns: 5,
				},
			],
			burnFindings: [],
			toolUsage: [],
		};
		render(
			<MetricsPage
				repos={[
					{
						id: "repo-1",
						slug: "my-repo",
						path: "/tmp/my-repo",
						defaultBranch: "main",
						remoteUrl: "https://example.com/my-repo.git",
						createdAt: 0,
					},
				]}
				onBack={() => {}}
			/>,
		);

		expect(
			await screen.findByText("Context estimate drift — dilna vs provider"),
		).toBeInTheDocument();
		expect(screen.getByText("Over-counting session")).toBeInTheDocument();
		expect(screen.getByText("Under-counting session")).toBeInTheDocument();
		// Signed, one line each: over-count amber, under-count red (the
		// dangerous direction — compaction fires too late).
		const over = screen.getByText("+42%");
		expect(over.className).toContain("text-warning");
		const under = screen.getByText("-61%");
		expect(under.className).toContain("text-danger");
	});

	it("hides the drift section while every estimator is honest (issue #270)", async () => {
		nextSummary = {
			totals: {
				...ZERO_TOTALS,
				inputTokens: 100,
				cacheHitRate: 0.9,
			},
			daily: [
				{
					date: "2026-08-27",
					...ZERO_TOTALS,
					inputTokens: 100,
					costUsd: 0.005,
				},
			],
			dailyByModel: [],
			byRepo: [],
			byModel: [],
			topSessions: [],
			byPurpose: [],
			burnFindings: [],
			toolUsage: [],
			contextDrift: [],
		};
		render(<MetricsPage repos={[]} onBack={() => {}} />);
		// Some usage exists (the empty-state banner is gone) but no Session
		// drifted — the card must not render at all.
		await screen.findByText("Cache health");
		expect(
			screen.queryByText("Context estimate drift — dilna vs provider"),
		).not.toBeInTheDocument();
	});

	it("lists burn findings worst-first with severity, evidence, and waste (issue #291)", async () => {
		nextSummary = {
			totals: { ...ZERO_TOTALS },
			daily: [
				{
					date: "2026-08-27",
					...ZERO_TOTALS,
					inputTokens: 500,
					costUsd: 0.01,
				},
			],
			dailyByModel: [],
			byRepo: [],
			byModel: [],
			topSessions: [],
			byPurpose: [],
			contextDrift: [],
			// Server order is worst first; the card renders it verbatim.
			burnFindings: [
				{
					check: "session-overdepth",
					severity: "critical",
					sessionId: "s-deep",
					repoId: "repo-1",
					title: "Deep diver",
					evidence:
						"Context sits at 90% of its model's 200k window at the median turn (deepest 96%); 3 of 3 reported turns land past the 70% line, and those turns are the Session's most expensive. Depth premium over the Session's own median turn: ~$0.10.",
					wasteUsd: 0.1,
				},
				{
					check: "session-overdepth",
					severity: "warning",
					sessionId: "s-unpriced",
					repoId: "repo-1",
					title: null,
					evidence:
						"Context sits at 75% of its model's 128k window at the median turn (deepest 80%); 3 of 3 reported turns land past the 70% line, and those turns are the Session's most expensive. The model has no price in the catalog, so the finding carries no dollar figure — never a computed zero.",
					wasteUsd: null,
				},
			],
			toolUsage: [],
		};
		render(
			<MetricsPage
				repos={[
					{
						id: "repo-1",
						slug: "my-repo",
						path: "/tmp/my-repo",
						defaultBranch: "main",
						remoteUrl: "https://example.com/my-repo.git",
						createdAt: 0,
					},
				]}
				onBack={() => {}}
			/>,
		);

		expect(
			await screen.findByText("Burn checks — where tokens are being wasted"),
		).toBeInTheDocument();

		// Document order is the server's worst-first order: the critical
		// finding's title precedes the unpriced one's deleted-session fallback.
		const deep = screen.getByText("Deep diver");
		const unpriced = screen.getByText("deleted session s-unpric…");
		expect(
			deep.compareDocumentPosition(unpriced) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();

		// Severity is the only thing the web derives: badge tone per level.
		expect(screen.getByText("critical").className).toContain("text-danger");
		expect(screen.getByText("warning").className).toContain("text-warning");

		// Waste renders from the number; the unpriced finding shows an em
		// dash, never a computed zero. The dash is asserted via its tooltip —
		// the page has other em dashes (null cache-hit rates render as one).
		expect(screen.getByText("~$0.10")).toBeInTheDocument();
		expect(
			screen.getByTitle("No catalog price for this model — no $ estimate"),
		).toHaveTextContent("—");
		// Evidence renders verbatim — the web computes nothing.
		expect(
			screen.getByText(/Depth premium over the Session's own median turn/),
		).toBeInTheDocument();
	});

	it("renders the C/M/S check labels and per-check waste hints (issue #294)", async () => {
		nextSummary = {
			totals: { ...ZERO_TOTALS },
			daily: [
				{
					date: "2026-08-27",
					...ZERO_TOTALS,
					inputTokens: 500,
					costUsd: 0.01,
				},
			],
			dailyByModel: [],
			byRepo: [],
			byModel: [],
			topSessions: [],
			byPurpose: [],
			contextDrift: [],
			burnFindings: [
				{
					check: "cache-rehydration",
					severity: "warning",
					sessionId: "s-cache",
					repoId: "repo-1",
					title: "Cache breaker",
					evidence:
						"3 of 9 reported turns re-wrote their whole prompt prefix as fresh cache writes (median 41k tokens per re-write). Cache-write premium over a warm cache on those turns: ~$0.03.",
					wasteUsd: 0.03,
				},
				{
					check: "model-overthinking",
					severity: "info",
					sessionId: "s-think",
					repoId: "repo-1",
					title: "Deep thinker",
					evidence:
						"Reasoning is 60% of generated output at the median turn (peak 81%); 4 of 9 turns spent more tokens thinking than answering. The model has no price in the catalog, so the finding carries no dollar figure — never a computed zero.",
					wasteUsd: null,
				},
				{
					check: "expensive-delegation",
					severity: "warning",
					sessionId: "s-orch",
					repoId: "repo-1",
					title: "The orchestrator",
					evidence:
						"Fan-out to 3 child Sessions spent $1.20 this range — 12× the orchestrator's own $0.10.",
					wasteUsd: null,
				},
			],
			toolUsage: [],
		};
		render(<MetricsPage repos={[]} onBack={() => {}} />);

		expect(
			await screen.findByText("Burn checks — where tokens are being wasted"),
		).toBeInTheDocument();

		// Every new check code gets its display label.
		expect(screen.getByText("Cache rehydration:")).toBeInTheDocument();
		expect(screen.getByText("Overthinking:")).toBeInTheDocument();
		expect(screen.getByText("Expensive delegation:")).toBeInTheDocument();

		// The $ column's tooltip follows the finding's own waste model, not
		// one global sentence.
		expect(
			screen.getByTitle(
				"Cache-write premium over a warm cache on the flagged re-writes",
			),
		).toBeInTheDocument();
		expect(
			screen.getByTitle(
				"Fan-out spend is real work, not waste — the total is in the evidence",
			),
		).toBeInTheDocument();
		// …and the unpriced overthinking finding keeps the generic dash hint.
		expect(
			screen.getByTitle("No catalog price for this model — no $ estimate"),
		).toBeInTheDocument();
	});

	it("reads the empty Burn checks card as an explicit all-clear (issue #291)", async () => {
		nextSummary = {
			totals: { ...ZERO_TOTALS },
			daily: [
				{
					date: "2026-08-27",
					...ZERO_TOTALS,
					inputTokens: 500,
					costUsd: 0.01,
				},
			],
			dailyByModel: [],
			byRepo: [],
			byModel: [],
			topSessions: [],
			byPurpose: [],
			contextDrift: [],
			burnFindings: [],
			toolUsage: [],
		};
		render(<MetricsPage repos={[]} onBack={() => {}} />);
		await screen.findByText("Cache health");
		expect(
			screen.getByText(/All clear — nothing in this range is burning/i),
		).toBeInTheDocument();
	});

	it("renders the tool & skill usage table when turns carry facts (issue #292)", async () => {
		nextSummary = {
			totals: {
				...ZERO_TOTALS,
				inputTokens: 100,
				cacheHitRate: 0.9,
			},
			daily: [
				{
					date: "2026-08-27",
					...ZERO_TOTALS,
					inputTokens: 100,
					costUsd: 0.005,
				},
			],
			dailyByModel: [],
			byRepo: [],
			byModel: [],
			topSessions: [],
			byPurpose: [],
			contextDrift: [],
			burnFindings: [],
			toolUsage: [
				{ name: "bash", kind: "tool", calls: 12, sessions: 3 },
				{ name: "tdd", kind: "skill", calls: 4, sessions: 2 },
			],
		};
		render(<MetricsPage repos={[]} onBack={() => {}} />);
		await screen.findByText("Tool & skill usage");
		expect(screen.getByText("bash")).toBeInTheDocument();
		// A skill row is labelled as one — its calls are read_skill loads, not
		// tool invocations, and the two must not read as the same thing.
		expect(screen.getByText("tdd")).toBeInTheDocument();
		expect(screen.getByText("· skill")).toBeInTheDocument();
	});

	it("hides the tool & skill usage table while no turn carries facts (issue #292)", async () => {
		nextSummary = {
			totals: {
				...ZERO_TOTALS,
				inputTokens: 100,
				cacheHitRate: 0.9,
			},
			daily: [
				{
					date: "2026-08-27",
					...ZERO_TOTALS,
					inputTokens: 100,
					costUsd: 0.005,
				},
			],
			dailyByModel: [],
			byRepo: [],
			byModel: [],
			topSessions: [],
			byPurpose: [],
			contextDrift: [],
			burnFindings: [],
			toolUsage: [],
		};
		render(<MetricsPage repos={[]} onBack={() => {}} />);
		// Usage exists, but it's all pre-feature turns — the capture is
		// forward-only, so the table is absent rather than full of zeros.
		await screen.findByText("Cache health");
		expect(screen.queryByText("Tool & skill usage")).not.toBeInTheDocument();
	});

	it("names the icon-only Back button (issue #223)", async () => {
		nextSummary = {
			totals: { ...ZERO_TOTALS },
			daily: [],
			dailyByModel: [],
			byRepo: [],
			byModel: [],
			topSessions: [],
			byPurpose: [],
			burnFindings: [],
			toolUsage: [],
			contextDrift: [],
		};
		const { container } = render(<MetricsPage repos={[]} onBack={() => {}} />);
		await screen.findByText(/no usage recorded yet/i);
		expectEveryButtonNamed(container);
	});
});
