import type { SessionStatus, SessionView } from "@dilna/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { usePersistedBoolean } from "@/hooks/usePersistedBoolean";

/**
 * Desktop/browser notifications on turn completion — issue #52.
 *
 * The hard part (a reliable, race-free terminal-status signal) is already
 * solved by ADR-0016's turn-lifecycle contract: `session_status` transitions
 * `working → idle` (or `crashed`) are emitted exactly once per turn, and only
 * once the turn's durable content is persisted. So the client just watches
 * the cross-session status stream (ADR-0008 / `api.sessionList.stream`) for
 * sessions entering a terminal status.
 *
 * Two surfaces, fed by the same transition:
 *
 * 1. **System notifications** — Web `Notification` API, available only when
 *    the user opts in (persisted `notificationsEnabled`, requested lazily the
 *    first time a completion would otherwise fire). Fires when a session
 *    whose turn just completed is *not* the one currently focused in this
 *    tab, and whenever a currently-viewed session completes while the whole
 *    tab is hidden (a visible chat already speaks for itself). Sound is
 *    deliberately out of scope for v1 (visual-only) — see the issue's open
 *    questions.
 *
 * 2. **Unread state** — a per-session count of completed turns that happened
 *    while that session was *not* focused. This is independent of OS
 *    permission and always on: it's what the sidebar's badges and aggregate
 *    bell render, and it's the graceful fallback when the user never grants
 *    Notification permission. Selecting a session clears its unread count,
 *    so "read" means "you've actually looked at it".
 */

/** Statuses that signal a turn is complete and durable (ADR-0016 §1: any
 * terminal status ⇒ a history refetch is safe and complete). */
const TERMINAL: readonly SessionStatus[] = ["idle", "crashed"];

/** Statuses that mean "a turn is in flight" — a transition out of these into
 * a terminal status is a real task completion, not a pause. */
const ACTIVE: readonly SessionStatus[] = ["starting", "working", "stopping"];

/** Guard: coalesce back-to-back completions on the same session into one
 * system notification so a fast agent doesn't spam the OS. */
const NOTIFY_COOLDOWN_MS = 5_000;

export function useSessionNotifications({
	selectedSessionId,
}: {
	selectedSessionId: string | null;
}) {
	const [unreadBySessionId, setUnreadBySessionId] = useState<
		Record<string, number>
	>({});
	/// Persisted opt-in for system notifications.
	const [enabled, setEnabled] = usePersistedBoolean(
		"dilna:session-notifications-enabled",
	);

	const previousStatusRef = useRef<Record<string, SessionStatus>>({});
	const lastNotifiedAtRef = useRef<Record<string, number>>({});
	// Enables/selected id are read through refs so `handleSessionStatus` stays
	// referentially stable — the App opens its cross-session stream once and
	// never wants a re-render to force a reconnect (see App.tsx). The refs are
	// updated inline above (rather than in an effect) so the value the event
	// fires with is always the freshest one.
	const selectedSessionIdRef = useRef(selectedSessionId);
	selectedSessionIdRef.current = selectedSessionId;
	const enabledRef = useRef(enabled);
	enabledRef.current = enabled;

	/// Turn system notifications on/off. Enabling requests the OS permission
	/// once; returns the resulting Notification.permission (for the toggle's
	/// disabled tooltip if the user denies it).
	const toggle = useCallback(async () => {
		if (!enabled) {
			// Best-effort: browsers may reject the prompt outside a user gesture.
			let granted =
				typeof Notification !== "undefined" &&
				Notification.permission === "granted";
			if (typeof Notification !== "undefined" && !granted) {
				try {
					granted = (await Notification.requestPermission()) === "granted";
				} catch {
					granted = false;
				}
			}
			// Persist the opt-in even if OS permission is denied — the toggle
			// reflects the *intent*; if they later grant permission in the
			// browser, notifications start flowing. The bell shows permission
			// state via its tooltip.
			setEnabled(true);
			return granted;
		}
		setEnabled(false);
		return true;
	}, [enabled, setEnabled]);

	const handleSessionStatus = useCallback((session: SessionView) => {
		const prev = previousStatusRef.current[session.id];
		previousStatusRef.current[session.id] = session.status;

		// Only a transition out of an active phase into a terminal status is
		// "task completion". First-connection snapshots (prev undefined) and
		// idle→idle levels are ignored.
		if (!prev || !ACTIVE.includes(prev) || !TERMINAL.includes(session.status)) {
			return;
		}

		// A session completing while it IS the one being viewed (and the tab
		// is visible) needs no badge and no notification — the user is
		// already looking at it.
		const tabHidden = typeof document !== "undefined" && document.hidden;
		const focused = session.id === selectedSessionIdRef.current && !tabHidden;
		if (focused) return;

		setUnreadBySessionId((prevMap) => ({
			...prevMap,
			[session.id]: (prevMap[session.id] ?? 0) + 1,
		}));

		// System notification — only for a clean `idle` completion (a
		// `crashed` session already stands out via the sidebar's red dot).
		if (
			enabledRef.current &&
			session.status === "idle" &&
			typeof Notification !== "undefined" &&
			Notification.permission === "granted"
		) {
			const now = Date.now();
			const last = lastNotifiedAtRef.current[session.id];
			if (last === undefined || now - last > NOTIFY_COOLDOWN_MS) {
				lastNotifiedAtRef.current[session.id] = now;
				try {
					new Notification(`dilna · ${session.title}`, {
						body: "Agent finished the turn.",
						tag: `dilna:${session.id}`,
					});
				} catch {
					// Some engines throw on `new Notification` (e.g. older
					// Safari) — treat as best-effort.
				}
			}
		}
	}, []);

	const markRead = useCallback((sessionId: string) => {
		setUnreadBySessionId((prev) => {
			if (!(sessionId in prev)) return prev;
			const next = { ...prev };
			delete next[sessionId];
			return next;
		});
	}, []);

	// Drop a session's unread entry entirely when it's deleted, so the
	// aggregate bell count doesn't drift to include sessions that no longer
	// exist (see App's `session_deleted` handler).
	const forgetSession = useCallback((sessionId: string) => {
		setUnreadBySessionId((prev) => {
			if (!(sessionId in prev)) return prev;
			const next = { ...prev };
			delete next[sessionId];
			return next;
		});
		delete previousStatusRef.current[sessionId];
	}, []);

	const totalUnread = Object.values(unreadBySessionId).reduce(
		(a, b) => a + b,
		0,
	);

	// When a currently-viewed session completes while the whole tab is hidden,
	// we mark it unread above. Coming back to the (still-selected) tab would
	// otherwise leave that badge stuck — the user is obviously looking at the
	// session now, so clear it the moment the tab is visible again.
	useEffect(() => {
		if (!selectedSessionId) return;
		const onVisibility = () => {
			if (!document.hidden) markRead(selectedSessionId);
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => document.removeEventListener("visibilitychange", onVisibility);
	}, [selectedSessionId, markRead]);

	return {
		/// Call from the cross-session status stream handler.
		handleSessionStatus,
		unreadBySessionId,
		totalUnread,
		markRead,
		forgetSession,
		notificationsEnabled: enabled,
		toggleNotifications: toggle,
	};
}
