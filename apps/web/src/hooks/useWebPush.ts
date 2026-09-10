import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";

/**
 * Web Push registration (ADR-0029) — the background half of turn-completion
 * notifications.
 *
 * `useSessionNotifications` can only notify while the page is running, which
 * on Android means "almost never": Chrome evicts backgrounded tabs, and its
 * page-scoped `new Notification()` constructor doesn't exist on mobile at
 * all. This hook registers a service worker and a push subscription so the
 * *server* can deliver instead, with the browser closed.
 *
 * It owns only the subscription lifecycle. Deciding when to notify lives on
 * the server (`transitionStatus` → `notifyTurnComplete`); rendering the
 * notification lives in `public/sw.js`.
 */

/** `applicationServerKey` wants raw bytes, not the base64url string the API
 * hands out. */
function base64UrlToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
	const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
	const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(base64);
	const output = new Uint8Array(new ArrayBuffer(raw.length));
	for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
	return output;
}

export type WebPushState = {
	/** Whether this browser can do push at all — false on iOS Safari outside
	 * an installed PWA, and in any browser without a service worker. */
	supported: boolean;
	/** Whether this browser currently has an active push subscription. */
	subscribed: boolean;
};

export function useWebPush() {
	const [state, setState] = useState<WebPushState>({
		supported: false,
		subscribed: false,
	});
	// Registration is async and racy against a fast unmount; a ref lets the
	// effect bail without setting state on a dead component.
	const mountedRef = useRef(true);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	const supported =
		typeof navigator !== "undefined" &&
		"serviceWorker" in navigator &&
		typeof window !== "undefined" &&
		"PushManager" in window;

	/** Register the service worker and report whether this browser already
	 * holds a subscription. Safe to call repeatedly — `register()` is
	 * idempotent for the same script URL. */
	const sync = useCallback(async () => {
		if (!supported) {
			if (mountedRef.current) setState({ supported: false, subscribed: false });
			return null;
		}
		try {
			const registration = await navigator.serviceWorker.register("/sw.js");
			const existing = await registration.pushManager.getSubscription();
			if (mountedRef.current) {
				setState({ supported: true, subscribed: existing !== null });
			}
			return registration;
		} catch {
			// A failed registration (insecure origin, blocked SW) is a
			// "push unavailable" signal, not an error worth surfacing — the
			// unread-badge fallback still works.
			if (mountedRef.current) setState({ supported: false, subscribed: false });
			return null;
		}
	}, [supported]);

	useEffect(() => {
		void sync();
	}, [sync]);

	/**
	 * Subscribe this browser and register the subscription server-side.
	 * Returns false when push is unavailable or the user denied permission,
	 * so the caller can keep the in-page path as the only channel.
	 *
	 * Assumes notification permission has already been requested by the
	 * caller — the toggle in `useSessionNotifications` does that as part of
	 * the same user gesture, and asking twice would prompt twice.
	 */
	const subscribe = useCallback(async () => {
		const registration = await sync();
		if (!registration) return false;
		try {
			const { publicKey, configured } = await api.push.key();
			if (!configured || !publicKey) return false;

			// Reuse an existing subscription rather than re-subscribing: the
			// browser returns the same endpoint anyway, and re-subscribing with a
			// different key throws instead of replacing.
			const existing = await registration.pushManager.getSubscription();
			const subscription =
				existing ??
				(await registration.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: base64UrlToUint8Array(publicKey),
				}));

			await api.push.subscribe(subscription.toJSON());
			if (mountedRef.current) setState({ supported: true, subscribed: true });
			return true;
		} catch {
			return false;
		}
	}, [sync]);

	/** Unsubscribe locally and drop the server-side row. Best-effort on both
	 * halves: the sender also prunes endpoints the push service reports as
	 * gone, so a failure here self-heals. */
	const unsubscribe = useCallback(async () => {
		if (!supported) return;
		try {
			const registration = await navigator.serviceWorker.ready;
			const subscription = await registration.pushManager.getSubscription();
			if (!subscription) {
				if (mountedRef.current) {
					setState({ supported: true, subscribed: false });
				}
				return;
			}
			const { endpoint } = subscription;
			await subscription.unsubscribe().catch(() => undefined);
			await api.push.unsubscribe(endpoint).catch(() => undefined);
			if (mountedRef.current) setState({ supported: true, subscribed: false });
		} catch {
			// Leave state as-is; the next `sync()` reconciles.
		}
	}, [supported]);

	return {
		pushSupported: state.supported,
		pushSubscribed: state.subscribed,
		subscribeToPush: subscribe,
		unsubscribeFromPush: unsubscribe,
	};
}
