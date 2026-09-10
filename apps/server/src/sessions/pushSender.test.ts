import { createECDH } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PushTransport } from "./pushSender";

let sender: typeof import("./pushSender");
let closeDb: typeof import("../db/index").closeDb;
let isTurnCompletion: typeof import("./pushSender").isTurnCompletion;

beforeAll(async () => {
	process.env.DILNA_DATA_DIR = mkdtempSync(
		path.join(tmpdir(), "dilna-sender-"),
	);
	sender = await import("./pushSender");
	({ closeDb } = await import("../db/index"));
	({ isTurnCompletion } = sender);
	sender.primeVapidKeys();
});

afterAll(() => {
	closeDb();
});

/**
 * The server-side completion rule (ADR-0029). This mirrors the client rule in
 * `useSessionNotifications`, and the cases that matter are the *negatives* —
 * `transitionStatus` runs on every status write, so an over-broad rule would
 * push a notification for turns that never happened.
 */
describe("isTurnCompletion", () => {
	it("fires on a real turn completion", () => {
		expect(isTurnCompletion("working", "idle")).toBe(true);
	});

	it("fires for a turn that ends from starting or stopping", () => {
		expect(isTurnCompletion("starting", "idle")).toBe(true);
		expect(isTurnCompletion("stopping", "idle")).toBe(true);
	});

	it("ignores an idle→idle re-write (a stop on an already-idle session)", () => {
		expect(isTurnCompletion("idle", "idle")).toBe(false);
	});

	it("ignores a first-observation transition with no previous status", () => {
		expect(isTurnCompletion(undefined, "idle")).toBe(false);
	});

	it("ignores non-terminal transitions", () => {
		expect(isTurnCompletion("idle", "working")).toBe(false);
		expect(isTurnCompletion("working", "stopping")).toBe(false);
		expect(isTurnCompletion("starting", "working")).toBe(false);
	});

	it("does not notify on a crash — the sidebar already surfaces it, and the copy would be wrong", () => {
		expect(isTurnCompletion("working", "crashed")).toBe(false);
	});

	it("ignores a crashed→idle recovery, which is not a completed turn", () => {
		expect(isTurnCompletion("crashed", "idle")).toBe(false);
	});
});

/**
 * Delivery policy — which HTTP status prunes a subscription and which retains
 * it. This is the consequential half of the module: pruning a live endpoint
 * silently unsubscribes a working phone, and retaining a dead one leaks rows
 * forever. Reachable only because `notifyTurnComplete` accepts its transport.
 */
describe("notifyTurnComplete delivery policy", () => {
	// A real P-256 point: `encryptPayload` does an actual ECDH against this, so
	// filler bytes would throw before the transport is ever reached.
	const subscriberEcdh = createECDH("prime256v1");
	subscriberEcdh.generateKeys();
	const SUB = {
		endpoint: "https://push.example.com/one",
		p256dh: subscriberEcdh.getPublicKey().toString("base64url"),
		auth: Buffer.alloc(16, 7).toString("base64url"),
	};

	const transportReturning = (status: number) => {
		const calls: string[] = [];
		const send: PushTransport = async (endpoint) => {
			calls.push(endpoint);
			return { ok: status >= 200 && status < 300, status };
		};
		return { send, calls };
	};

	beforeEach(() => {
		for (const s of sender.listSubscriptions()) {
			sender.deleteSubscription(s.endpoint);
		}
		sender.saveSubscription(SUB);
	});

	it("sends to a registered subscription", async () => {
		const { send, calls } = transportReturning(201);
		await sender.notifyTurnComplete("s1", "My session", send);
		expect(calls).toEqual([SUB.endpoint]);
		expect(sender.subscriptionCount()).toBe(1);
	});

	it.each([
		404, 410,
	])("prunes a subscription the push service reports gone (%i)", async (status) => {
		const { send } = transportReturning(status);
		await sender.notifyTurnComplete("s1", "My session", send);
		expect(sender.subscriptionCount()).toBe(0);
	});

	it.each([
		429, 500, 503,
	])("retains a subscription on a transient failure (%i)", async (status) => {
		const { send } = transportReturning(status);
		await sender.notifyTurnComplete("s1", "My session", send);
		// Dropping the row here would silently unsubscribe a working browser.
		expect(sender.subscriptionCount()).toBe(1);
	});

	it("retains a subscription when the transport throws", async () => {
		const send: PushTransport = async () => {
			throw new Error("network down");
		};
		await sender.notifyTurnComplete("s1", "My session", send);
		expect(sender.subscriptionCount()).toBe(1);
	});

	it("prunes only the dead subscription, leaving healthy ones", async () => {
		sender.saveSubscription({
			...SUB,
			endpoint: "https://push.example.com/two",
		});
		const send: PushTransport = async (endpoint) =>
			endpoint.endsWith("/one")
				? { ok: false, status: 410 }
				: { ok: true, status: 201 };

		await sender.notifyTurnComplete("s1", "My session", send);
		expect(sender.listSubscriptions().map((s) => s.endpoint)).toEqual([
			"https://push.example.com/two",
		]);
	});

	it("one failing subscription doesn't stop delivery to the others", async () => {
		sender.saveSubscription({
			...SUB,
			endpoint: "https://push.example.com/two",
		});
		const delivered: string[] = [];
		const send: PushTransport = async (endpoint) => {
			if (endpoint.endsWith("/one")) throw new Error("boom");
			delivered.push(endpoint);
			return { ok: true, status: 201 };
		};

		await sender.notifyTurnComplete("s1", "My session", send);
		expect(delivered).toEqual(["https://push.example.com/two"]);
	});

	it("is a no-op with no subscriptions registered", async () => {
		sender.deleteSubscription(SUB.endpoint);
		const { send, calls } = transportReturning(201);
		await sender.notifyTurnComplete("s1", "My session", send);
		expect(calls).toEqual([]);
	});
});

/**
 * Delivery health. `lastSuccessAt` is the only externally visible evidence
 * that push works end to end — a subscription row alone proves a browser
 * registered, not that anything was ever delivered.
 */
describe("delivery health", () => {
	const subscriberEcdh = createECDH("prime256v1");
	subscriberEcdh.generateKeys();
	const SUB = {
		endpoint: "https://push.example.com/health",
		p256dh: subscriberEcdh.getPublicKey().toString("base64url"),
		auth: Buffer.alloc(16, 7).toString("base64url"),
	};

	beforeEach(() => {
		for (const s of sender.listSubscriptions()) {
			sender.deleteSubscription(s.endpoint);
		}
		sender.saveSubscription(SUB);
	});

	it("reports no successful delivery for a fresh subscription", () => {
		expect(sender.deliveryStatus()).toEqual({
			subscriptions: 1,
			lastSuccessAt: null,
		});
	});

	it("records a timestamp once a push is accepted", async () => {
		const send: PushTransport = async () => ({ ok: true, status: 201 });
		await sender.notifyTurnComplete("s1", "My session", send);
		const { lastSuccessAt } = sender.deliveryStatus();
		expect(lastSuccessAt).not.toBeNull();
		// Epoch seconds, matching every other timestamp column.
		expect(lastSuccessAt).toBeCloseTo(Math.floor(Date.now() / 1000), -1);
	});

	it("leaves it null when delivery fails, so a failure can't look like success", async () => {
		const send: PushTransport = async () => ({ ok: false, status: 500 });
		await sender.notifyTurnComplete("s1", "My session", send);
		expect(sender.deliveryStatus().lastSuccessAt).toBeNull();
	});

	it("reports the most recent success across several subscriptions", async () => {
		sender.saveSubscription({
			...SUB,
			endpoint: "https://push.example.com/health-2",
		});
		sender.markDelivered(SUB.endpoint, 1000);
		sender.markDelivered("https://push.example.com/health-2", 2000);
		expect(sender.deliveryStatus()).toEqual({
			subscriptions: 2,
			lastSuccessAt: 2000,
		});
	});

	it("survives re-subscription without losing the delivery record", () => {
		sender.markDelivered(SUB.endpoint, 1234);
		// A browser re-subscribing upserts on the same endpoint; that must not
		// silently reset the evidence that delivery once worked.
		sender.saveSubscription(SUB);
		expect(sender.deliveryStatus().lastSuccessAt).toBe(1234);
	});
});
