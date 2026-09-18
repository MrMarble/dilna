import {
	notificationTag,
	type SessionView,
	turnCompleteNotification,
} from "@dilna/shared";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionNotifications } from "@/hooks/useSessionNotifications";
import { makeSession as sharedMakeSession } from "@/test/factories";

function makeSession(id: string, status: SessionView["status"]): SessionView {
	// Title carries the id: the notification body is built from it, so the
	// assertions need them to differ per Session.
	return sharedMakeSession({ id, status, title: `Session ${id}` });
}

const NotificationMock = vi.fn();
// `useSessionNotifications` gates the in-page notification on
// `Notification.permission === "granted"`, so the mock has to look granted for
// the notification path to be reachable at all.
Object.assign(NotificationMock, {
	permission: "granted",
	requestPermission: vi.fn(async () => "granted"),
});

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	Object.assign(NotificationMock, { permission: "granted" });
	(globalThis as Record<string, unknown>).Notification = NotificationMock;
});

describe("useSessionNotifications", () => {
	it("marks a session unread when its turn completes while not focused", () => {
		const { result } = renderHook(() =>
			useSessionNotifications({ selectedSessionId: null }),
		);

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
		const { result } = renderHook(() =>
			useSessionNotifications({ selectedSessionId: null }),
		);

		act(() => {
			result.current.handleSessionStatus(makeSession("s1", "working"));
			result.current.handleSessionStatus(makeSession("s1", "working"));
		});

		expect(result.current.totalUnread).toBe(0);
	});

	it("markRead clears a session's unread count", () => {
		const { result } = renderHook(() =>
			useSessionNotifications({ selectedSessionId: null }),
		);

		act(() => {
			result.current.handleSessionStatus(makeSession("s1", "working"));
			result.current.handleSessionStatus(makeSession("s1", "idle"));
			result.current.markRead("s1");
		});

		expect(result.current.totalUnread).toBe(0);
	});

	// ADR-0029 dedups push and in-page notifications by both sides raising the
	// *same* OS tag; the title/body are shared too. This asserts the in-page
	// path uses that shared composition rather than its own copies of the
	// strings — the drift the shared module exists to prevent.
	it("raises the notification with the shared title, body and tag", async () => {
		const { result } = renderHook(() =>
			useSessionNotifications({ selectedSessionId: null }),
		);

		await act(async () => {
			await result.current.toggleNotifications();
		});
		NotificationMock.mockClear();

		act(() => {
			result.current.handleSessionStatus(makeSession("s1", "working"));
			result.current.handleSessionStatus(makeSession("s1", "idle"));
		});

		expect(NotificationMock).toHaveBeenCalledWith(
			turnCompleteNotification({ id: "s1", title: "Session s1" }).title,
			expect.objectContaining({
				body: "Agent finished the turn.",
				tag: notificationTag("s1"),
			}),
		);
	});
});
