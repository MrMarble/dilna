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
 * subscription registered by any authenticated browser receives every
 * turn-completion notification. All of these sit behind the same bearer-auth
 * middleware as the rest of `/api/*`.
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
	// Reject anything that isn't an absolute http(s) endpoint: this value is
	// used as a `fetch` target on the server, so a bad one is an SSRF vector,
	// not just a malformed row.
	let parsed: URL;
	try {
		parsed = new URL(b.endpoint);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
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
