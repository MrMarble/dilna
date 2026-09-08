import type { UsageSummary } from "@dilna/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MetricsPage } from "@/components/MetricsPage";

const ZERO_TOTALS = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	reasoningTokens: 0,
	costUsd: 0,
};

let nextSummary: UsageSummary = {
	totals: { ...ZERO_TOTALS },
	daily: [],
	dailyByModel: [],
	byRepo: [],
	byModel: [],
	topSessions: [],
};

vi.mock("@/api/client", () => ({
	api: {
		usage: {
			summary: async () => ({ summary: nextSummary }),
			disk: async () => ({
				disk: { totalBytes: 10_000, freeBytes: 4_000 },
			}),
		},
	},
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
		expect(screen.getByText("Fix the flaky test")).toBeInTheDocument();

		// Legend lists every model present in the stacked daily chart.
		expect(screen.getAllByText("claude-opus-5").length).toBeGreaterThan(0);
		expect(screen.getAllByText("deepseek-v4-pro").length).toBeGreaterThan(0);
	});
});
