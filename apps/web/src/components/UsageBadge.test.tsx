import type { AgentStreamEvent, UsageTotals } from "@dilna/shared";
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsageBadge } from "@/components/UsageBadge";

type StreamListener = (ev: AgentStreamEvent) => void;

const listenersBySession = new Map<string, StreamListener>();
/** Per-session persisted usage served by the mocked GET — the seed the badge
 * fetches on mount. Sessions not present resolve with zero usage. */
const persistedUsageBySession = new Map<string, UsageTotals>();

vi.mock("@/api/client", () => ({
	api: {
		sessions: {
			get: async (sessionId: string) => ({
				session: {
					usage: persistedUsageBySession.get(sessionId) ?? {
						inputTokens: 0,
						outputTokens: 0,
					},
				},
			}),
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

/** Render and flush the mount-time persisted-usage fetch. */
async function renderBadge(sessionId: string) {
	const result = render(<UsageBadge sessionId={sessionId} />);
	await act(async () => {});
	return result;
}

describe("UsageBadge", () => {
	beforeEach(() => {
		listenersBySession.clear();
		persistedUsageBySession.clear();
	});

	it("shows 0 tokens for a fresh session with no usage yet", async () => {
		await renderBadge("s1");
		expect(screen.getByText("Tokens · 0")).toBeInTheDocument();
	});

	it("seeds from the session's persisted totals instead of restarting at 0", async () => {
		persistedUsageBySession.set("s1", {
			inputTokens: 1_000,
			outputTokens: 500,
		});
		await renderBadge("s1");
		expect(screen.getByText("Tokens · 1.5k")).toBeInTheDocument();
	});

	it("sums per-message usage deltas live during a turn", async () => {
		await renderBadge("s1");

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

	it("reconciles to the authoritative cumulative total when the turn ends", async () => {
		await renderBadge("s1");

		emit("s1", { type: "session_status", status: "working" });
		emit("s1", {
			type: "usage_update",
			messageId: "m1",
			usage: { inputTokens: 100, outputTokens: 50 },
		});
		// Turn-end reconciliation carries the authoritative session-lifetime
		// total (server-rewritten from the DB), which need not equal the sum
		// of live deltas exactly.
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

	it("does not let the mount-time seed clobber a cumulative that streamed in first", async () => {
		persistedUsageBySession.set("s1", { inputTokens: 100, outputTokens: 0 });
		const result = render(<UsageBadge sessionId="s1" />);
		// A turn-end cumulative arrives before the seed fetch resolves — it's
		// fresher than the persisted row it was written alongside.
		emit("s1", {
			type: "usage_update",
			messageId: "m1",
			usage: { inputTokens: 200, outputTokens: 100 },
			cumulative: { inputTokens: 200, outputTokens: 100 },
		});
		await act(async () => {}); // now let the seed fetch resolve
		expect(screen.getByText("Tokens · 300")).toBeInTheDocument();
		result.unmount();
	});

	it("switches to the new session's persisted totals when the session changes", async () => {
		persistedUsageBySession.set("s1", { inputTokens: 100, outputTokens: 50 });
		persistedUsageBySession.set("s2", { inputTokens: 10, outputTokens: 10 });
		const { rerender } = await renderBadge("s1");
		expect(screen.getByText("Tokens · 150")).toBeInTheDocument();

		rerender(<UsageBadge sessionId="s2" />);
		await act(async () => {});
		expect(screen.getByText("Tokens · 20")).toBeInTheDocument();
	});

	it("formats large token counts compactly", async () => {
		await renderBadge("s1");
		emit("s1", { type: "session_status", status: "working" });
		emit("s1", {
			type: "usage_update",
			messageId: "m1",
			usage: { inputTokens: 900_000, outputTokens: 150_000 },
		});
		expect(screen.getByText("Tokens · 1.1m")).toBeInTheDocument();
	});
});
