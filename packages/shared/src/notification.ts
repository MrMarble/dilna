import type { SessionStatus } from "./events";
import type { SessionView } from "./session";

/**
 * What a turn-completion notification *is* — the payload, its OS tag, its
 * copy, and the rule that decides when one fires. Shared because three
 * packages compose it and ADR-0029 depends on all three agreeing:
 *
 * - `apps/server`'s `sessions/pushSender.ts` encrypts the payload and POSTs it
 *   to the browser's push endpoint.
 * - `apps/web`'s `useSessionNotifications.ts` raises the same notification
 *   in-page via `new Notification()`.
 * - `apps/web/public/sw.js` decodes the push payload and calls
 *   `showNotification()` on the service worker registration — the mobile path.
 *
 * ADR-0029 dedups the push and in-page channels *by both sides using the same
 * OS tag*, and that equality used to be two hand-typed template literals in
 * different packages (`dilna:${id}`), only one of which was unit-tested. The
 * title and body strings were written twice as well, and `sw.js` — a static
 * asset TypeScript never sees — consumed a `PushPayload` that only existed on
 * the server, so renaming a field there was a green build and a silently
 * broken notification tap.
 *
 * Icons, colours and anything else presentational stay in the web, which is
 * what actually raises the notification.
 */

/** The fields `sw.js` reads out of a push message. Named here, not on the
 * server, because the service worker is the type's real consumer. */
export type PushPayload = {
	title: string;
	body: string;
	/** Which Session to open when the notification is tapped. */
	sessionId: string;
	/** OS replace-key — see {@link notificationTag}. */
	tag: string;
};

/** Stable per-Session identity, used only to give the OS a replace-key so a
 * second notification for the same Session replaces the first rather than
 * stacking. Both delivery channels must produce the same string for that to
 * work, which is why it lives here rather than beside either one. */
export function notificationTag(sessionId: string): string {
	return `dilna:${sessionId}`;
}

/** The notification for "this Session's Agent finished a turn". One
 * composition of title/body/tag/sessionId, replacing three. */
export function turnCompleteNotification(
	session: Pick<SessionView, "id" | "title">,
): PushPayload {
	return {
		title: `dilna · ${session.title}`,
		body: "Agent finished the turn.",
		sessionId: session.id,
		tag: notificationTag(session.id),
	};
}

/**
 * Whether a status transition means the user should hear about a completed
 * turn.
 *
 * Only a transition *out of* an active phase into `idle` counts. The status
 * write fires for every change, so without the `previous` check an `idle →
 * idle` re-write (stopping an already-stopped Session, boot recovery) would
 * notify about a turn that never ran.
 *
 * `crashed` deliberately does not notify: it is already conspicuous in the
 * sidebar, and "Agent finished the turn." would misdescribe it.
 *
 * This is the rule the *notification* uses, and it is narrower than the web's
 * unread-badge rule on purpose. The badge counts a `crashed` transition as a
 * completed turn worth marking unread; the notification does not. Both the
 * client's `useSessionNotifications` and the server's `pushSender` call this
 * for the notification decision, so the asymmetry lives in one place instead
 * of being re-derived (and re-explained) on each side. */
export function isTurnCompletion(
	previous: SessionStatus | undefined,
	next: SessionStatus,
): boolean {
	if (next !== "idle") return false;
	return (
		previous === "working" || previous === "starting" || previous === "stopping"
	);
}

/** The statuses that mean "a turn is in flight". A transition out of one of
 * these is a real completion rather than a pause. */
export const ACTIVE_STATUSES: readonly SessionStatus[] = [
	"starting",
	"working",
	"stopping",
];

/** The statuses that mean a turn is complete and durable (ADR-0016 §1: any
 * terminal status ⇒ a history refetch is safe). */
export const TERMINAL_STATUSES: readonly SessionStatus[] = ["idle", "crashed"];
