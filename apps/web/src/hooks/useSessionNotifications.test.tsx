import type { SessionView } from "@dilna/shared";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionNotifications } from "@/hooks/useSessionNotifications";

function makeSession(id: string, status: SessionView["status"]): SessionView {
	return {
		id,
		repoId: "repo-1",
		title: `Session ${id}`,
		agentType: "pi",
		kind: "session",
		status,
		usage: { inputTokens: 0, outputTokens: 0 },
		createdAt: 1,
		lastActiveAt: 1,
	};
}

const NotificationMock = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	(globalThis as Record<string, unknown>).Notification = NotificationMock;
});

describe("useSessionNotifications", () => {
	it("marks a session unread when its turn completes while not focused", () => {
		const { result } = renderHook(() => useSessionNotifications({ selectedSessionId: null }));

		act(() => {
			result.current.handleSessionStatus(makeSession("s1", "working"));
			result.current.handleSessionStatus(makeSession("s1", "idle"));
		});

		expect(result.current.unreadBySessionId.s1).toBe(1);
		expect(result.current.totalUnread).toBe(1);
	});

	it("does not mark the focused session unread", () => {
		const { result } = renderHook(() =>
			useSessionNotifications({ selectedSessionId: "focused" }),
		);

		act(() => {
			result.current.handleSessionStatus(makeSession("focused", "working"));
			result.current.handleSessionStatus(makeSession("focused", "idle"));
		});

		expect(result.current.totalUnread).toBe(0);
	});

	it("does not count a working→working (pause) as completion", () => {
		const { result } = renderHook(() => useSessionNotifications({ selectedSessionId: null }));

		act(() => {
			result.current.handleSessionStatus(makeSession("s1", "working"));
			result.current.handleSessionStatus(makeSession("s1", "working"));
		});

		expect(result.current.totalUnread).toBe(0);
	});

	it("markRead clears a session's unread count", () => {
		const { result } = renderHook(() => useSessionNotifications({ selectedSessionId: null }));

		act(() => {
			result.current.handleSessionStatus(makeSession("s1", "working"));
			result.current.handleSessionStatus(makeSession("s1", "idle"));
			result.current.markRead("s1");
		});

		expect(result.current.totalUnread).toBe(0);
	});
});
