import type {
	RateLimitWindow,
	SessionListEvent,
	SessionView,
} from "@dilna/shared";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionList } from "@/hooks/useSessionList";

/**
 * The cross-Session SSE fold (ADR-0008) that `useSessionList` owns — issue
 * #174. Driving it through the hook's return value means a test can push an
 * arbitrary event sequence at it without rendering Sidebar or ChatShell.
 */

function makeSession(over: Partial<SessionView> = {}): SessionView {
	return {
		id: "sess-1",
		repoId: "repo-1",
		title: "Repo session",
		agentType: "pi",
		kind: "session",
		status: "idle",
		usage: { inputTokens: 0, outputTokens: 0 },
		createdAt: 1,
		lastActiveAt: 1,
		...over,
	};
}

const stream = vi.hoisted(() => ({
	/** The handler the hook registered, so a test can push events at it. */
	emit: null as ((event: SessionListEvent) => void) | null,
	unsubscribe: vi.fn(),
	subscribeCount: 0,
}));

vi.mock("@/api/client", () => ({
	api: {
		sessionList: {
			stream: (onEvent: (event: SessionListEvent) => void) => {
				stream.emit = onEvent;
				stream.subscribeCount += 1;
				return stream.unsubscribe;
			},
		},
	},
}));

/** Push an event through the mocked stream, as the server would. */
function emit(event: SessionListEvent) {
	act(() => {
		stream.emit?.(event);
	});
}

function statusEvent(session: SessionView): SessionListEvent {
	return { type: "session_status", session };
}

function deletedEvent(sessionId: string): SessionListEvent {
	return { type: "session_deleted", sessionId };
}

beforeEach(() => {
	stream.emit = null;
	stream.unsubscribe.mockReset();
	stream.subscribeCount = 0;
});

/** Renders the hook with stable no-op notification callbacks unless a test
 * wants to observe them. */
function render(
	over: {
		selectedSessionId?: string | null;
		onSessionStatus?: (s: SessionView) => void;
		onSessionForgotten?: (id: string) => void;
	} = {},
) {
	const onSessionStatus = over.onSessionStatus ?? vi.fn();
	const onSessionForgotten = over.onSessionForgotten ?? vi.fn();
	const rendered = renderHook(
		({ selectedSessionId }: { selectedSessionId: string | null }) =>
			useSessionList({
				selectedSessionId,
				onSessionStatus,
				onSessionForgotten,
			}),
		{
			initialProps: {
				selectedSessionId: over.selectedSessionId ?? null,
			},
		},
	);
	return { ...rendered, onSessionStatus, onSessionForgotten };
}

describe("useSessionList — the stream", () => {
	it("folds session_status into the map, keyed by id", () => {
		const { result } = render();
		const session = makeSession();
		emit(statusEvent(session));

		expect(result.current.sessionsById).toEqual({ "sess-1": session });
	});

	it("a later status for the same Session replaces it rather than duplicating", () => {
		const { result } = render();
		emit(statusEvent(makeSession()));
		emit(statusEvent(makeSession({ status: "working", lastActiveAt: 9 })));

		expect(Object.keys(result.current.sessionsById)).toEqual(["sess-1"]);
		expect(result.current.sessionsById["sess-1"]?.status).toBe("working");
	});

	it("drops a deleted Session from the map", () => {
		const { result } = render();
		emit(statusEvent(makeSession()));
		emit(deletedEvent("sess-1"));

		expect(result.current.sessionsById).toEqual({});
	});

	it("collects rate-limit windows", () => {
		const { result } = render();
		const windows: RateLimitWindow[] = [
			{ kind: "five_hour", utilizationPct: 12, resetsAt: 100 },
		];
		emit({ type: "rate_limits", windows });

		expect(result.current.rateLimitWindows).toEqual(windows);
	});

	it("opens exactly one subscription and keeps it across re-renders", () => {
		const { rerender } = render({ selectedSessionId: null });
		expect(stream.subscribeCount).toBe(1);

		// A selection change must not reconnect the stream — that's why the
		// notification callbacks are contractually stable.
		rerender({ selectedSessionId: "sess-1" });
		emit(statusEvent(makeSession()));
		rerender({ selectedSessionId: "sess-2" });

		expect(stream.subscribeCount).toBe(1);
		expect(stream.unsubscribe).not.toHaveBeenCalled();
	});

	it("unsubscribes on unmount", () => {
		const { unmount } = render();
		unmount();
		expect(stream.unsubscribe).toHaveBeenCalledTimes(1);
	});
});

describe("useSessionList — notification callbacks", () => {
	it("hands every status transition to the unread watcher (issue #52)", () => {
		const onSessionStatus = vi.fn();
		render({ onSessionStatus });

		const working = makeSession({ status: "working" });
		emit(statusEvent(working));
		const idle = makeSession({ status: "idle" });
		emit(statusEvent(idle));

		expect(onSessionStatus.mock.calls).toEqual([[working], [idle]]);
	});

	it("a deleted Session is forgotten, so the bell's count can't stay inflated", () => {
		const onSessionForgotten = vi.fn();
		render({ onSessionForgotten });
		emit(statusEvent(makeSession()));
		emit(deletedEvent("sess-1"));

		expect(onSessionForgotten).toHaveBeenCalledWith("sess-1");
	});

	it("doesn't forget a Session that was never in the map", () => {
		// A `session_deleted` for something this client never saw is a no-op on
		// the map, but the watcher is still told — it keys off its own state.
		const { result } = render();
		emit(deletedEvent("ghost"));
		expect(result.current.sessionsById).toEqual({});
	});
});

describe("useSessionList — local mutations", () => {
	it("upsert makes a just-created Session visible before its event arrives", () => {
		const { result } = render();
		const session = makeSession({ id: "sess-new" });

		act(() => result.current.upsert(session));
		expect(result.current.sessionsById["sess-new"]).toEqual(session);

		// The stream event for the same Session re-applies the same edit.
		emit(statusEvent(session));
		expect(Object.keys(result.current.sessionsById)).toEqual(["sess-new"]);
	});

	it("remove drops a Session whose DELETE this client already confirmed", () => {
		const { result } = render();
		emit(statusEvent(makeSession()));

		act(() => result.current.remove("sess-1"));
		expect(result.current.sessionsById).toEqual({});

		// The server's own `session_deleted` then lands on an already-empty map.
		emit(deletedEvent("sess-1"));
		expect(result.current.sessionsById).toEqual({});
	});
});

describe("useSessionList — derived groupings", () => {
	const REPO_A_OLD = makeSession({ id: "a-old", lastActiveAt: 1 });
	const REPO_A_NEW = makeSession({ id: "a-new", lastActiveAt: 5 });
	const REPO_B = makeSession({ id: "b", repoId: "repo-2", lastActiveAt: 3 });
	const ORCHESTRATOR = makeSession({
		id: "orc-1",
		kind: "orchestrator",
		lastActiveAt: 7,
	});

	function renderWithAll(selectedSessionId: string | null = null) {
		const rendered = render({ selectedSessionId });
		for (const s of [REPO_A_OLD, REPO_A_NEW, REPO_B, ORCHESTRATOR]) {
			emit(statusEvent(s));
		}
		return rendered;
	}

	it("groups by Repo, newest-active first", () => {
		const { result } = renderWithAll();
		expect(result.current.sessionsByRepoId).toEqual({
			"repo-1": [REPO_A_NEW, REPO_A_OLD],
			"repo-2": [REPO_B],
		});
	});

	it("keeps orchestrator Sessions out of the per-Repo grouping (ADR-0021)", () => {
		const { result } = renderWithAll();
		// They belong to a hidden meta-Repo, so nesting them under it would
		// render them nowhere.
		for (const list of Object.values(result.current.sessionsByRepoId)) {
			expect(list.some((s) => s.kind === "orchestrator")).toBe(false);
		}
		expect(result.current.orchestratorSessions).toEqual([ORCHESTRATOR]);
	});

	it("background Sessions are the non-idle ones other than the selected", () => {
		const working = makeSession({
			id: "w",
			status: "working",
			lastActiveAt: 2,
		});
		const alsoWorking = makeSession({
			id: "w2",
			status: "working",
			lastActiveAt: 8,
		});
		const { result } = render({ selectedSessionId: "w" });
		emit(statusEvent(makeSession({ id: "idle-one", status: "idle" })));
		emit(statusEvent(working));
		emit(statusEvent(alsoWorking));

		// Idle ones aren't "background work"; the selected one is on screen.
		expect(result.current.backgroundSessions).toEqual([alsoWorking]);
	});

	it("re-derives background Sessions when the selection changes", () => {
		const working = makeSession({ id: "w", status: "working" });
		const { result, rerender } = render({ selectedSessionId: "w" });
		emit(statusEvent(working));
		expect(result.current.backgroundSessions).toEqual([]);

		rerender({ selectedSessionId: null });
		expect(result.current.backgroundSessions).toEqual([working]);
	});
});
