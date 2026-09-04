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
	byRepo: [],
	byModel: [],
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
			byRepo: [],
			byModel: [],
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

		// Total cost card and the single repo's breakdown row both show
		// $1.23 (same underlying total, since there's only one repo).
		expect(await screen.findAllByText("$1.23")).toHaveLength(2);
		expect(screen.getByText("my-repo")).toBeInTheDocument();
	});
});
