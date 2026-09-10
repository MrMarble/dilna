import { eq } from "drizzle-orm";
import { getDb } from "../db/index";
import { pushSubscriptions, pushVapidKeys } from "../db/schema";
import { logger } from "../logger";
import {
	buildVapidHeader,
	encryptPayload,
	endpointFingerprint,
	generateVapidKeys,
	notificationTag,
	type VapidKeypair,
} from "./webPush";

/**
 * Web Push delivery for turn completion (ADR-0029) — key lifecycle,
 * subscription storage, and the send itself.
 *
 * This is the half of push that owns *state*; the protocol math lives in
 * webPush.ts. The split matters because the crypto is pure and exhaustively
 * testable, while this module is all I/O: SQLite, `fetch`, and the pruning
 * policy for subscriptions the push service has given up on.
 *
 * Delivery is best-effort by design. A push that fails must never affect the
 * turn that triggered it — `notifyTurnComplete` is called from
 * `transitionStatus` on the session hot path, so every error is caught and
 * logged rather than propagated.
 */

const VAPID_ROW_ID = "instance";

/** Epoch *seconds*, matching every other timestamp column in the schema. */
const now = () => Math.floor(Date.now() / 1000);

/**
 * VAPID's `sub` claim: a contact for whoever operates this push endpoint, so
 * a push service can reach a human about abuse. dilna is self-hosted with no
 * operator identity on file, and the claim is never surfaced to users, so a
 * stable placeholder is used rather than inventing a config knob nobody would
 * set. Push services require the claim to be present and well-formed; they do
 * not verify it resolves.
 */
const VAPID_SUBJECT = "mailto:dilna@localhost";

/** Mirrors the VAPID row so the send path doesn't hit SQLite per subscription
 * — the same module-global cache pattern `providerConfigStore` uses. */
let vapidCache: VapidKeypair | null = null;

/**
 * Load the instance VAPID keypair, generating and persisting one on first
 * boot. Called once from `index.ts`, before any push can be sent.
 *
 * Generation is deliberately lazy-but-eager: lazy in that a fresh install
 * needs no operator setup, eager in that it happens at boot rather than on
 * first send, so the public key is available to `/api/push/key` immediately.
 * The pair is never rotated — every stored subscription is bound to it (see
 * the schema's doc comment).
 */
export function primeVapidKeys(): void {
	const db = getDb();
	const row = db
		.select()
		.from(pushVapidKeys)
		.where(eq(pushVapidKeys.id, VAPID_ROW_ID))
		.get();
	if (row) {
		vapidCache = { publicKey: row.publicKey, privateKey: row.privateKey };
		return;
	}
	const generated = generateVapidKeys();
	db.insert(pushVapidKeys)
		.values({
			id: VAPID_ROW_ID,
			publicKey: generated.publicKey,
			privateKey: generated.privateKey,
		})
		.run();
	vapidCache = generated;
	logger.info("generated a new VAPID keypair for web push");
}

/** The instance's VAPID public key, for `pushManager.subscribe`. Null before
 * {@link primeVapidKeys} has run. */
export function vapidPublicKey(): string | null {
	return vapidCache?.publicKey ?? null;
}

export type StoredSubscription = {
	endpoint: string;
	p256dh: string;
	auth: string;
};

/**
 * Register (or refresh) a browser's subscription. Keyed by endpoint, so a
 * browser that re-subscribes replaces its row instead of adding one — the
 * endpoint is the push service's own identifier for the subscription, and
 * re-subscribing without unsubscribing yields the same value.
 */
export function saveSubscription(subscription: StoredSubscription): void {
	const db = getDb();
	db.insert(pushSubscriptions)
		.values({
			endpoint: subscription.endpoint,
			p256dh: subscription.p256dh,
			auth: subscription.auth,
		})
		.onConflictDoUpdate({
			target: pushSubscriptions.endpoint,
			set: { p256dh: subscription.p256dh, auth: subscription.auth },
		})
		.run();
}

export function deleteSubscription(endpoint: string): void {
	const db = getDb();
	db.delete(pushSubscriptions)
		.where(eq(pushSubscriptions.endpoint, endpoint))
		.run();
}

/**
 * Record that the push service accepted a delivery for this endpoint.
 *
 * This is the only externally visible evidence that push works end to end:
 * a subscription row proves a browser *registered*, not that anything was
 * ever delivered. Without it, distinguishing "never attempted" from "attempted
 * and rejected" means reading server logs.
 *
 * Note this records the push *service* accepting the message (a 201 from
 * FCM), not the handset displaying it — there is no delivery receipt in the
 * Web Push protocol. A recent timestamp here with no notification on the
 * phone narrows the fault to the device or service worker rather than dilna.
 */
export function markDelivered(endpoint: string, at: number = now()): void {
	const db = getDb();
	db.update(pushSubscriptions)
		.set({ lastSuccessAt: at })
		.where(eq(pushSubscriptions.endpoint, endpoint))
		.run();
}

export function listSubscriptions(): StoredSubscription[] {
	const db = getDb();
	return db
		.select()
		.from(pushSubscriptions)
		.all()
		.map((row) => ({
			endpoint: row.endpoint,
			p256dh: row.p256dh,
			auth: row.auth,
		}));
}

export function subscriptionCount(): number {
	return listSubscriptions().length;
}

/**
 * Delivery health for the whole instance, for `/api/push/key`. Answers "has a
 * push ever actually been accepted?" without needing DB access — the question
 * that matters when a phone isn't buzzing and it's unclear whether the server
 * is even trying.
 */
export function deliveryStatus(): {
	subscriptions: number;
	lastSuccessAt: number | null;
} {
	const db = getDb();
	const rows = db.select().from(pushSubscriptions).all();
	const timestamps = rows
		.map((r) => r.lastSuccessAt)
		.filter((t): t is number => t !== null);
	return {
		subscriptions: rows.length,
		lastSuccessAt: timestamps.length ? Math.max(...timestamps) : null,
	};
}

/**
 * How a payload actually reaches a push service. Defaults to the global
 * `fetch`; tests substitute a stub.
 *
 * This is the module's one real seam. Delivery *policy* — which HTTP status
 * means "prune this subscription" versus "retry later" — is the most
 * consequential logic here (pruning a live endpoint silently unsubscribes a
 * working phone), and baking in the global `fetch` would put it past the
 * interface where no test can reach it.
 */
export type PushTransport = (
	endpoint: string,
	init: { headers: Record<string, string>; body: Uint8Array },
) => Promise<{ ok: boolean; status: number }>;

/** Bound the wait on a push service. Without it a hung endpoint leaks a
 * pending request per subscription per turn — fire-and-forget means nothing
 * ever awaits these to completion. */
const PUSH_TIMEOUT_MS = 10_000;

const defaultTransport: PushTransport = async (endpoint, init) =>
	fetch(endpoint, {
		method: "POST",
		headers: init.headers,
		body: init.body,
		signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
	});

/**
 * Whether a status transition represents a completed turn worth notifying
 * about — the server-side twin of `useSessionNotifications`'s client rule.
 *
 * Only a transition *out of* an active phase into `idle` counts.
 * `transitionStatus` fires for every status write, so without the `previous`
 * check an `idle → idle` re-write (stopping an already-stopped session, boot
 * recovery) would notify about a turn that never ran.
 *
 * `crashed` deliberately doesn't notify: it's already conspicuous in the
 * sidebar, and "Agent finished the turn." would misdescribe it.
 */
export function isTurnCompletion(
	previous: string | undefined,
	next: string,
): boolean {
	if (next !== "idle") return false;
	return (
		previous === "working" || previous === "starting" || previous === "stopping"
	);
}

export type PushPayload = {
	title: string;
	body: string;
	/** Which session to open when the notification is tapped. */
	sessionId: string;
	tag: string;
};

/**
 * Deliver one payload to one subscription.
 *
 * Returns `"gone"` when the push service reports the subscription is dead
 * (404/410 are the spec's two "stop sending to this endpoint" codes), which
 * the caller uses to prune. Any other failure is `"failed"` and left alone —
 * a 429 or a 500 is transient, and dropping the row would silently
 * unsubscribe a working browser.
 */
async function sendOne(
	subscription: StoredSubscription,
	payload: PushPayload,
	vapid: VapidKeypair,
	send: PushTransport,
): Promise<"sent" | "gone" | "failed"> {
	const body = encryptPayload(JSON.stringify(payload), {
		p256dh: subscription.p256dh,
		auth: subscription.auth,
	});
	const response = await send(subscription.endpoint, {
		headers: {
			Authorization: buildVapidHeader(
				subscription.endpoint,
				vapid,
				VAPID_SUBJECT,
			),
			"Content-Encoding": "aes128gcm",
			"Content-Type": "application/octet-stream",
			// Wake the device even when it's dozing — reaching a locked phone is
			// the whole point, and `normal` lets the OS defer delivery until the
			// next time it happens to wake.
			Urgency: "high",
			TTL: "86400",
		},
		body: new Uint8Array(body),
	});
	if (response.ok) return "sent";
	if (response.status === 404 || response.status === 410) return "gone";
	logger.warn(
		{
			endpoint: endpointFingerprint(subscription.endpoint),
			status: response.status,
		},
		"web push delivery failed",
	);
	return "failed";
}

/**
 * Fan a turn-completion notification out to every registered browser.
 *
 * Called from `transitionStatus` (ADR-0016 §1 — the single funnel every
 * status change runs through, firing once per turn and only after the turn's
 * content is durable), so this inherits at-most-once-per-turn semantics for
 * free rather than re-deriving them.
 *
 * Unlike the in-page path in `useSessionNotifications`, there is no focus
 * suppression: the server has no idea which session a browser is looking at.
 * See ADR-0029's deduplication note for why that is currently acceptable.
 */
export async function notifyTurnComplete(
	sessionId: string,
	sessionTitle: string,
	send: PushTransport = defaultTransport,
): Promise<void> {
	const vapid = vapidCache;
	if (!vapid) return;
	const subscriptions = listSubscriptions();
	if (subscriptions.length === 0) return;

	const payload: PushPayload = {
		title: `dilna · ${sessionTitle}`,
		body: "Agent finished the turn.",
		sessionId,
		tag: notificationTag(sessionId),
	};

	const results = await Promise.all(
		subscriptions.map(async (subscription) => {
			try {
				return await sendOne(subscription, payload, vapid, send);
			} catch (error) {
				logger.warn(
					{
						endpoint: endpointFingerprint(subscription.endpoint),
						err: error,
					},
					"web push delivery threw",
				);
				return "failed" as const;
			}
		}),
	);

	results.forEach((result, index) => {
		const subscription = subscriptions[index];
		if (!subscription) return;
		if (result === "sent") {
			markDelivered(subscription.endpoint);
			return;
		}
		if (result === "gone") {
			// The push service says this endpoint no longer exists — the browser
			// was uninstalled, cleared, or revoked permission. Prune eagerly so
			// the table doesn't accumulate dead rows.
			deleteSubscription(subscription.endpoint);
			logger.info(
				{ endpoint: endpointFingerprint(subscription.endpoint) },
				"pruned an expired push subscription",
			);
		}
	});
}

/** Reset the cached keypair. Tests only — production primes once at boot. */
export function resetVapidCacheForTests(): void {
	vapidCache = null;
}
