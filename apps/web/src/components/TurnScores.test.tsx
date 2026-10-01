import type { LlmConfig, TurnScore } from "@dilna/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import { ScoreTurnButton, TurnScoreList } from "@/components/TurnScores";

/**
 * The score dialog's request shape (ADR-0046) and the score chip. What this
 * pins is the part the server can't see: that picking the Session's own model
 * sends *no* judge override (so the server's default resolution stays the one
 * source for it), and that picking another model does.
 */

function makeScore(overrides: Partial<TurnScore> = {}): TurnScore {
	return {
		id: "sc-1",
		sessionId: "sess-1",
		turnId: "turn-1",
		metric: "criteria",
		criteria: "ran the tests",
		provider: "anthropic",
		model: "claude-a",
		score: 0.8,
		threshold: 0.5,
		passed: true,
		reason: "Tests were run.",
		createdAt: 0,
		...overrides,
	};
}

const config = {
	apiKeysConfigured: { anthropic: true, openai: true, google: false },
	modelsByProvider: {
		anthropic: [{ id: "claude-a", name: "Claude A" }],
		openai: [{ id: "gpt-x", name: "GPT X" }],
		google: [{ id: "gem", name: "Gem" }],
	},
} as unknown as LlmConfig;

beforeEach(() => {
	vi.restoreAllMocks();
	vi.spyOn(api.config, "get").mockResolvedValue(config);
});

async function openDialog() {
	const onScored = vi.fn();
	render(
		<ScoreTurnButton
			sessionId="sess-1"
			turnId="turn-1"
			sessionProvider="anthropic"
			sessionModel="claude-a"
			onScored={onScored}
		/>,
	);
	await userEvent.click(
		screen.getByRole("button", { name: "Score this turn" }),
	);
	await screen.findByRole("option", { name: /^openai \/ GPT X/ });
	return onScored;
}

describe("ScoreTurnButton", () => {
	it("scores with the Session's model by sending no judge override", async () => {
		const score = makeScore();
		const scoreTurn = vi
			.spyOn(api.sessions, "scoreTurn")
			.mockResolvedValue({ score });
		const onScored = await openDialog();

		const submit = screen.getByRole("button", { name: "Score" });
		expect(submit).toBeDisabled();
		await userEvent.type(screen.getByLabelText("Criteria"), "ran the tests");
		await userEvent.click(submit);

		await waitFor(() => expect(onScored).toHaveBeenCalledWith(score));
		expect(scoreTurn).toHaveBeenCalledWith("sess-1", "turn-1", {
			metric: "criteria",
			criteria: "ran the tests",
			threshold: 0.5,
			provider: undefined,
			model: undefined,
		});
	});

	it("sends the picked judge and only offers keyed providers", async () => {
		const scoreTurn = vi
			.spyOn(api.sessions, "scoreTurn")
			.mockResolvedValue({ score: makeScore({ metric: "relevancy" }) });
		await openDialog();

		expect(screen.queryByRole("option", { name: /Gem/ })).toBeNull();
		await userEvent.selectOptions(screen.getByLabelText("Metric"), "relevancy");
		expect(screen.queryByLabelText("Criteria")).toBeNull();
		await userEvent.selectOptions(
			screen.getByLabelText("Judge model"),
			"openai/gpt-x",
		);
		await userEvent.click(screen.getByRole("button", { name: "Score" }));

		await waitFor(() =>
			expect(scoreTurn).toHaveBeenCalledWith("sess-1", "turn-1", {
				metric: "relevancy",
				criteria: undefined,
				threshold: 0.5,
				provider: "openai",
				model: "gpt-x",
			}),
		);
	});

	// Issue #311: with the cheap role configured the server judges on it
	// when no override is sent, so the select shows it as the default and
	// picking the Session's own model becomes an explicit override.
	it("defaults to the cheap model role when one is configured", async () => {
		vi.spyOn(api.config, "get").mockResolvedValue({
			...config,
			roles: { cheap: { provider: "openai", model: "gpt-x" } },
		} as LlmConfig);
		const scoreTurn = vi
			.spyOn(api.sessions, "scoreTurn")
			.mockResolvedValue({ score: makeScore() });
		await openDialog();

		const select = screen.getByLabelText("Judge model");
		await waitFor(() => expect(select).toHaveValue("openai/gpt-x"));
		expect(
			screen.getByRole("option", { name: "openai / GPT X (cheap model)" }),
		).toBeInTheDocument();

		await userEvent.type(screen.getByLabelText("Criteria"), "x");
		await userEvent.click(screen.getByRole("button", { name: "Score" }));
		// The default needs no override — the server resolves the role itself.
		await waitFor(() =>
			expect(scoreTurn).toHaveBeenLastCalledWith(
				"sess-1",
				"turn-1",
				expect.objectContaining({ provider: undefined, model: undefined }),
			),
		);
	});

	it("sends the Session's model as an explicit override when cheap is the default", async () => {
		vi.spyOn(api.config, "get").mockResolvedValue({
			...config,
			roles: { cheap: { provider: "openai", model: "gpt-x" } },
		} as LlmConfig);
		const scoreTurn = vi
			.spyOn(api.sessions, "scoreTurn")
			.mockResolvedValue({ score: makeScore() });
		await openDialog();
		await waitFor(() =>
			expect(screen.getByLabelText("Judge model")).toHaveValue("openai/gpt-x"),
		);
		await userEvent.selectOptions(
			screen.getByLabelText("Judge model"),
			"anthropic/claude-a",
		);
		await userEvent.type(screen.getByLabelText("Criteria"), "x");
		await userEvent.click(screen.getByRole("button", { name: "Score" }));
		await waitFor(() =>
			expect(scoreTurn).toHaveBeenLastCalledWith(
				"sess-1",
				"turn-1",
				expect.objectContaining({
					provider: "anthropic",
					model: "claude-a",
				}),
			),
		);
	});

	it("keeps the dialog open with the server's message on failure", async () => {
		vi.spyOn(api.sessions, "scoreTurn").mockRejectedValue(
			new Error("no API key configured for openai"),
		);
		await openDialog();
		await userEvent.type(screen.getByLabelText("Criteria"), "x");
		await userEvent.click(screen.getByRole("button", { name: "Score" }));
		expect(
			await screen.findByText("no API key configured for openai"),
		).toBeInTheDocument();
	});
});

describe("TurnScoreList", () => {
	it("shows score and verdict, and expands to the reason", async () => {
		render(
			<TurnScoreList scores={[makeScore({ score: 0.3, passed: false })]} />,
		);
		const chip = screen.getByRole("button", { name: /Criteria/ });
		expect(chip).toHaveTextContent("0.30");
		expect(chip).toHaveTextContent("fail");
		expect(screen.queryByText("Tests were run.")).toBeNull();
		await userEvent.click(chip);
		expect(screen.getByText("Tests were run.")).toBeInTheDocument();
		expect(
			screen.getByText(/Judged by anthropic\/claude-a/),
		).toBeInTheDocument();
	});
});
