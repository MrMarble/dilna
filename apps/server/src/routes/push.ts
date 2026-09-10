import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
	deleteSubscription,
	saveSubscription,
	subscriptionCount,
	vapidPublicKey,
} from "../sessions/pushSender";

/**
 * Web Push subscription management (ADR-0029).
 *
 * Three endpoints, all instance-global: dilna has no per-user model, so a
 * subscription registered by any browser receives every turn-completion
 * notification.
 *
 * These sit behind the same bearer auth as the rest of `/api/*` — which is
 * *opt-in* (`DILNA_AUTH_TOKEN`; see index.ts), so on a default deployment
 * they are unauthenticated. That matters more here than for a typical read
 * route, because `/subscribe` persists a URL the server later POSTs to: see
 * the scheme check in `isSubscribeBody`.
 */
export const pushRoute = new Hono();

type SubscribeBody = {
	endpoint: string;
	keys: { p256dh: string; auth: string };
};

function isSubscribeBody(body: unknown): body is SubscribeBody {
	if (typeof body !== "object" || body === null) return false;
	const b = body as Record<string, unknown>;
	if (typeof b.endpoint !== "string" || b.endpoint.length === 0) return false;
	// This value becomes a server-side `fetch` target, so a hostile one is an
	// SSRF vector rather than just a malformed row. Requiring HTTPS is the
	// cheap 90%: it rejects `file://`, and it rules out the plaintext
	// `http://localhost:6379`-style probes at internal services. Real push
	// endpoints (FCM, Mozilla, WNS) are always HTTPS, so this costs nothing.
	//
	// It does not stop an `https://` URL pointing at a private address; a full
	// fix would be an allowlist of known push origins, which would also break
	// self-hosted push services. Given a single-user app whose other routes
	// already run arbitrary agent code, this is the proportionate line.
	let parsed: URL;
	try {
		parsed = new URL(b.endpoint);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:") return false;
	const keys = b.keys as Record<string, unknown> | undefined;
	return (
		typeof keys === "object" &&
		keys !== null &&
		typeof keys.p256dh === "string" &&
		keys.p256dh.length > 0 &&
		typeof keys.auth === "string" &&
		keys.auth.length > 0
	);
}

/**
 * The instance's VAPID public key, which the client needs before it can call
 * `pushManager.subscribe`. `configured: false` means the key hasn't been
 * primed yet — the client treats that as "push unavailable" rather than an
 * error, so a browser can still fall back to unread badges.
 */
pushRoute.get("/key", (c) => {
	const key = vapidPublicKey();
	return c.json({ publicKey: key, configured: key !== null });
});

pushRoute.post("/subscribe", async (c) => {
	const body = await c.req.json().catch(() => null);
	if (!isSubscribeBody(body)) {
		throw new HTTPException(400, {
			message:
				"Expected { endpoint, keys: { p256dh, auth } } from PushSubscription.toJSON().",
		});
	}
	saveSubscription({
		endpoint: body.endpoint,
		p256dh: body.keys.p256dh,
		auth: body.keys.auth,
	});
	return c.json({ ok: true, subscriptions: subscriptionCount() });
});

/**
 * Drop a subscription. Called when the user turns notifications off, and
 * best-effort on the client when the browser reports the subscription has
 * changed — the sender also prunes dead endpoints on 404/410, so a missed
 * call here is self-healing rather than a leak.
 */
pushRoute.post("/unsubscribe", async (c) => {
	const body = await c.req.json().catch(() => null);
	const endpoint =
		typeof body === "object" && body !== null
			? (body as Record<string, unknown>).endpoint
			: undefined;
	if (typeof endpoint !== "string" || endpoint.length === 0) {
		throw new HTTPException(400, { message: "Expected { endpoint }." });
	}
	deleteSubscription(endpoint);
	return c.json({ ok: true, subscriptions: subscriptionCount() });
});
