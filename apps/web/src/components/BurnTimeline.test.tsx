import type { AgentStreamEvent, SessionBurnTurn } from "@dilna/shared";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BurnTimeline } from "@/components/BurnTimeline";
import type { PartialApi } from "@/test/api-mock";

type StreamListener = (ev: AgentStreamEvent) => void;

const listenersBySession = new Map<string, StreamListener>();
/** What the mocked GET serves; mutated per test. */
let nextTurns: SessionBurnTurn[];
/** How many times the timeline endpoint was hit — the "refetch on turn end,
 * never poll" assertion reads this. */
let fetchCount: number;

vi.mock("@/api/client", () => ({
	api: {
		sessions: {
			burnTimeline: async (_sessionId: string) => {
				fetchCount += 1;
				return { turns: nextTurns };
			},
			stream: (sessionId: string, onEvent: StreamListener) => {
				listenersBySession.set(sessionId, onEvent);
				return () => listenersBySession.delete(sessionId);
			},
		},
	} satisfies PartialApi,
}));

function emit(sessionId: string, ev: AgentStreamEvent) {
	act(() => {
		listenersBySession.get(sessionId)?.(ev);
	});
}

async function renderTimeline(sessionId = "s1") {
	const result = render(<BurnTimeline sessionId={sessionId} />);
	await act(async () => {});
	return result;
}

function makeTurn(overrides: Partial<SessionBurnTurn> = {}): SessionBurnTurn {
	return {
		turn: 1,
		at: 1_700_000_000,
		purpose: "turn",
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0,
		costUsd: 0,
		providerContextTokens: null,
		estimatedContextTokens: null,
		contextWindow: null,
		compacted: false,
		...overrides,
	};
}

describe("BurnTimeline", () => {
	beforeEach(() => {
		listenersBySession.clear();
		nextTurns = [];
		fetchCount = 0;
	});

	it("renders the empty state when no usage is recorded", async () => {
		nextTurns = [];
		await renderTimeline();
		expect(
			await screen.findByText(/no burn recorded yet/i),
		).toBeInTheDocument();
	});

	it("renders a single turn without bar, occupancy, or markers", async () => {
		nextTurns = [makeTurn({ turn: 1 })];
		await renderTimeline();
		expect(await screen.findByText("1 turn")).toBeInTheDocument();
		expect(screen.getByText("#1")).toBeInTheDocument();
		expect(screen.queryByText("compacted")).not.toBeInTheDocument();
		expect(screen.queryByText("Judge call")).not.toBeInTheDocument();
		// No context stamps → no occupancy strip text.
		expect(screen.queryByText(/ctx/)).not.toBeInTheDocument();
	});

	it("renders per-turn composition, cost, occupancy, and markers for a Session with history", async () => {
		nextTurns = [
			makeTurn({
				turn: 1,
				inputTokens: 100,
				outputTokens: 50,
				reasoningTokens: 10,
				costUsd: 0.02,
				providerContextTokens: 900_000,
				estimatedContextTokens: 880_000,
				contextWindow: 1_000_000,
			}),
			makeTurn({
				turn: 2,
				inputTokens: 100,
				cacheReadTokens: 400,
				cacheWriteTokens: 200,
				costUsd: 0.01,
				providerContextTokens: null,
				estimatedContextTokens: 200_000,
				contextWindow: 1_000_000,
				// The compaction marker renders on the turn it landed on.
				compacted: true,
			}),
			makeTurn({
				turn: null,
				purpose: "judge",
				inputTokens: 500,
				costUsd: 0.004,
			}),
			// Issue #307: a subagent run is a side call like a judge call — a
			// marker, not a numbered turn.
			makeTurn({
				turn: null,
				purpose: "subagent",
				inputTokens: 300,
				costUsd: 0.0004,
			}),
		];
		await renderTimeline();

		expect(await screen.findByText("2 turns")).toBeInTheDocument();
		// Total cost sums side spend too (0.02 + 0.01 + 0.004 + 0.0004).
		expect(screen.getByText("$0.03")).toBeInTheDocument();

		expect(screen.getByText("#1")).toBeInTheDocument();
		expect(screen.getByText("#2")).toBeInTheDocument();
		expect(screen.getByText("compacted")).toBeInTheDocument();
		expect(screen.getByText("Judge call")).toBeInTheDocument();
		expect(screen.getByText("Subagent")).toBeInTheDocument();

		// Provider-reported occupancy renders solid with its exact figure; the
		// estimate-only fallback is labelled as such. When a turn carries both
		// figures, the estimate rides along as a tick on the same scale
		// (the strip's title spells both readings out).
		expect(screen.getByText("900k ctx")).toBeInTheDocument();
		expect(screen.getByText("~200k ctx est.")).toBeInTheDocument();
		expect(
			screen.getByTitle(
				"Context this turn — provider reported 900k, dilna's estimate 880k",
			),
		).toBeInTheDocument();
		expect(screen.getByTitle("dilna's estimate: 880k")).toBeInTheDocument();

		// Segment tooltips carry the raw facts (cache read+write combined).
		expect(screen.getByTitle("Cache: 600")).toBeInTheDocument();
		expect(screen.getAllByTitle("Input: 100")).toHaveLength(2);
	});

	it("refetches once per turn-end usage_update and never on in-turn deltas", async () => {
		nextTurns = [makeTurn({ turn: 1 })];
		await renderTimeline();
		expect(fetchCount).toBe(1);

		emit("s1", {
			type: "usage_update",
			messageId: "m1",
			usage: { inputTokens: 10, outputTokens: 5 },
			// In-turn delta: no cumulative → not a turn end → no refetch.
		});
		expect(fetchCount).toBe(1);

		emit("s1", {
			type: "usage_update",
			messageId: "m2",
			usage: { inputTokens: 10, outputTokens: 5 },
			cumulative: { inputTokens: 20, outputTokens: 10 },
			providerContextTokens: 1500,
		});
		await act(async () => {});
		expect(fetchCount).toBe(2);

		// Unrelated stream traffic doesn't refetch either.
		emit("s1", { type: "session_status", status: "idle" });
		await act(async () => {});
		expect(fetchCount).toBe(2);
	});
});
