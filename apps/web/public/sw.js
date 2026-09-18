/**
 * dilna service worker — Web Push delivery only (ADR-0029).
 *
 * Deliberately scoped to notifications: no offline caching, no asset
 * precaching, no fetch handler. A caching service worker on a self-hosted app
 * that redeploys frequently is a stale-asset generator, and none of that is
 * needed to make a phone buzz.
 *
 * This exists because Chrome for Android does not support the page-scoped
 * `new Notification()` constructor at all — `showNotification()` on a service
 * worker registration is the only way to raise a notification there, and the
 * only way to raise one when no tab is running.
 *
 * Type-checked as its own project (`tsconfig.sw.json`): the payload this
 * decodes is the server's `PushPayload`, and the field names are the contract
 * between them. Before it was checked, renaming `sessionId` here or there was
 * a green build on both sides and a notification tap that went nowhere.
 *
 * @ts-check
 */

/** @typedef {import("@dilna/shared/notification").PushPayload} PushPayload */

// `self` is a `ServiceWorkerGlobalScope` here, but the `WebWorker` lib alone
// doesn't model the service-worker *events* (`PushEvent`, `NotificationEvent`)
// or `self.registration`. The handlers' event types are therefore annotated
// explicitly rather than inferred — which is also what makes the payload
// contract below checkable.
const sw = /** @type {ServiceWorkerGlobalScope} */ (
	/** @type {unknown} */ (self)
);

sw.addEventListener("install", () => {
	// Take over immediately rather than waiting for existing tabs to close;
	// there is no cached state that a version skew could corrupt.
	sw.skipWaiting();
});

sw.addEventListener("activate", (event) => {
	event.waitUntil(sw.clients.claim());
});

sw.addEventListener("push", (event) => {
	if (!event.data) return;

	/** @type {PushPayload} */
	let payload;
	try {
		payload = event.data.json();
	} catch {
		return;
	}

	const title = payload.title || "dilna";
	// `tag` makes the OS replace a previous notification for the same session
	// instead of stacking one per turn. See ADR-0029's deduplication note for
	// why the in-page path intentionally uses the same tag.
	event.waitUntil(
		sw.registration.showNotification(title, {
			body: payload.body || "",
			tag: payload.tag,
			data: { sessionId: payload.sessionId },
			icon: "/icon-192.png",
			badge: "/icon-192.png",
		}),
	);
});

/**
 * Focus an existing dilna tab when the notification is tapped, rather than
 * opening a duplicate one; only open a new window if nothing is running.
 * The session id rides along so the app can select the right session.
 */
sw.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const sessionId = event.notification.data?.sessionId;
	const target = sessionId ? `/?session=${encodeURIComponent(sessionId)}` : "/";

	event.waitUntil(
		sw.clients
			.matchAll({ type: "window", includeUncontrolled: true })
			.then((clientList) => {
				for (const client of clientList) {
					if ("focus" in client) {
						if (sessionId && "navigate" in client) {
							return client.focus().then(() => client.navigate(target));
						}
						return client.focus();
					}
				}
				return sw.clients.openWindow(target);
			}),
	);
});
