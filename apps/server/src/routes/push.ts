import {
	type PushKeyResponse,
	type PushSubscriptionsResponse,
	pushSubscribeBodySchema,
	pushUnsubscribeBodySchema,
} from "@dilna/shared";
import { Hono } from "hono";
import {
	deleteSubscription,
	deliveryStatus,
	saveSubscription,
	subscriptionCount,
	vapidPublicKey,
} from "../sessions/pushSender";
import { validate } from "./factory";

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
 * route, because `/subscribe` persists a URL the server later POSTs to: the
 * https-only SSRF check that guards it now lives on
 * `pushSubscribeBodySchema` in `@dilna/shared`, which carries the full
 * rationale for where that line is drawn.
 */
export const pushRoute = new Hono();

/**
 * The instance's VAPID public key, which the client needs before it can call
 * `pushManager.subscribe`. `configured: false` means the key hasn't been
 * primed yet — the client treats that as "push unavailable" rather than an
 * error, so a browser can still fall back to unread badges.
 *
 * Also serves delivery health, which makes this the one endpoint to hit when
 * notifications aren't arriving: `configured` says the server can send,
 * `subscriptions` says a browser registered, and `lastSuccessAt` says a push
 * service actually accepted one. A null `lastSuccessAt` with subscriptions > 0
 * means dilna has never had a delivery accepted — a different fault from
 * "accepted but the phone showed nothing".
 */
pushRoute.get("/key", (c) => {
	const key = vapidPublicKey();
	const body: PushKeyResponse = {
		publicKey: key,
		configured: key !== null,
		...deliveryStatus(),
	};
	return c.json(body);
});

pushRoute.post("/subscribe", validate("json", pushSubscribeBodySchema), (c) => {
	const body = c.req.valid("json");
	saveSubscription({
		endpoint: body.endpoint,
		p256dh: body.keys.p256dh,
		auth: body.keys.auth,
	});
	const res: PushSubscriptionsResponse = {
		ok: true,
		subscriptions: subscriptionCount(),
	};
	return c.json(res);
});

/**
 * Drop a subscription. Called when the user turns notifications off, and
 * best-effort on the client when the browser reports the subscription has
 * changed — the sender also prunes dead endpoints on 404/410, so a missed
 * call here is self-healing rather than a leak.
 */
pushRoute.post(
	"/unsubscribe",
	validate("json", pushUnsubscribeBodySchema),
	(c) => {
		deleteSubscription(c.req.valid("json").endpoint);
		const res: PushSubscriptionsResponse = {
			ok: true,
			subscriptions: subscriptionCount(),
		};
		return c.json(res);
	},
);
