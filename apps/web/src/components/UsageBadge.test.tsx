import type { AgentStreamEvent } from "@dilna/shared";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsageBadge } from "@/components/UsageBadge";

type StreamListener = (ev: AgentStreamEvent) => void;

const listenersBySession = new Map<string, StreamListener>();

vi.mock("@/api/client", () => ({
	api: {
		sessions: {
			stream: (sessionId: string, onEvent: StreamListener) => {
				listenersBySession.set(sessionId, onEvent);
				return () => listenersBySession.delete(sessionId);
			},
		},
	},
}));

// emit() drives the mocked SSE listener directly, outside any React event
// handler, so it must be wrapped in act() for the resulting setState calls
// to flush before assertions run.
function emit(sessionId: string, ev: AgentStreamEvent) {
	act(() => {
		listenersBySession.get(sessionId)?.(ev);
	});
}

describe("UsageBadge", () => {
	beforeEach(() => {
		listenersBySession.clear();
	});

	it("shows 0 tokens for a fresh session with no usage yet", () => {
		render(<UsageBadge sessionId="s1" />);
		expect(screen.getByText("Tokens · 0")).toBeInTheDocument();
	});

	it("sums per-message usage deltas live during a turn", () => {
		render(<UsageBadge sessionId="s1" />);

		emit("s1", { type: "session_status", status: "working" });
		emit("s1", {
			type: "usage_update",
			messageId: "m1",
			usage: { inputTokens: 100, outputTokens: 50 },
		});
		expect(screen.getByText("Tokens · 150")).toBeInTheDocument();

		emit("s1", {
			type: "usage_update",
			messageId: "m1",
			usage: { inputTokens: 40, outputTokens: 10 },
		});
		expect(screen.getByText("Tokens · 200")).toBeInTheDocument();
	});

	it("reconciles to the authoritative cumulative total when the turn ends", () => {
		render(<UsageBadge sessionId="s1" />);

		emit("s1", { type: "session_status", status: "working" });
		emit("s1", {
			type: "usage_update",
			messageId: "m1",
			usage: { inputTokens: 100, outputTokens: 50 },
		});
		// Turn-end reconciliation carries the authoritative cumulative total,
		// which need not equal the sum of live deltas exactly (it's the whole
		// CLI session's cumulative usage).
		emit("s1", {
			type: "usage_update",
			messageId: "m1",
			usage: { inputTokens: 120, outputTokens: 60 },
			cumulative: { inputTokens: 120, outputTokens: 60 },
		});
		expect(screen.getByText("Tokens · 180")).toBeInTheDocument();

		// A new turn accumulates on top of the reconciled baseline.
		emit("s1", { type: "session_status", status: "working" });
		emit("s1", {
			type: "usage_update",
			messageId: "m2",
			usage: { inputTokens: 5, outputTokens: 5 },
		});
		expect(screen.getByText("Tokens · 190")).toBeInTheDocument();
	});

	it("resets to zero when the session changes", () => {
		const { rerender } = render(<UsageBadge sessionId="s1" />);
		emit("s1", { type: "session_status", status: "working" });
		emit("s1", {
			type: "usage_update",
			messageId: "m1",
			usage: { inputTokens: 100, outputTokens: 50 },
		});
		expect(screen.getByText("Tokens · 150")).toBeInTheDocument();

		rerender(<UsageBadge sessionId="s2" />);
		expect(screen.getByText("Tokens · 0")).toBeInTheDocument();
	});

	it("formats large token counts compactly", () => {
		render(<UsageBadge sessionId="s1" />);
		emit("s1", { type: "session_status", status: "working" });
		emit("s1", {
			type: "usage_update",
			messageId: "m1",
			usage: { inputTokens: 900_000, outputTokens: 150_000 },
		});
		expect(screen.getByText("Tokens · 1.1m")).toBeInTheDocument();
	});
});
