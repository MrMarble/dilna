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

	it("names the icon-only Back button (issue #223)", async () => {
		nextSummary = {
			totals: { ...ZERO_TOTALS },
			daily: [],
			dailyByModel: [],
			byRepo: [],
			byModel: [],
			topSessions: [],
			byPurpose: [],
		};
		const { container } = render(<MetricsPage repos={[]} onBack={() => {}} />);
		await screen.findByText(/no usage recorded yet/i);
		expectEveryButtonNamed(container);
	});
});
