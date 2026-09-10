import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let pushRoute: typeof import("./push").pushRoute;
let sender: typeof import("../sessions/pushSender");
let closeDb: typeof import("../db/index").closeDb;

beforeAll(async () => {
	// Scratch DB per the repo's test convention — avoids the fixture Repo and
	// real git worktree the manager tests need.
	process.env.DILNA_DATA_DIR = mkdtempSync(path.join(tmpdir(), "dilna-push-"));
	({ pushRoute } = await import("./push"));
	sender = await import("../sessions/pushSender");
	({ closeDb } = await import("../db/index"));
	sender.primeVapidKeys();
});

afterAll(() => {
	closeDb();
});

const SUBSCRIPTION = {
	endpoint: "https://fcm.googleapis.com/fcm/send/abc",
	keys: { p256dh: "BPublicKeyBytes", auth: "AuthSecret" },
};

beforeEach(() => {
	for (const s of sender.listSubscriptions()) {
		sender.deleteSubscription(s.endpoint);
	}
});

describe("GET /key", () => {
	it("serves the primed VAPID public key", async () => {
		const res = await pushRoute.request("/key");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			configured: boolean;
			publicKey: string | null;
		};
		expect(body.configured).toBe(true);
		expect(body.publicKey).toBe(sender.vapidPublicKey());
	});

	// The one endpoint to hit when notifications aren't arriving: it has to
	// distinguish "nothing registered" from "registered but never delivered".
	it("reports delivery health alongside the key", async () => {
		const body = (await (await pushRoute.request("/key")).json()) as {
			subscriptions: number;
			lastSuccessAt: number | null;
		};
		expect(body).toMatchObject({ subscriptions: 0, lastSuccessAt: null });

		sender.saveSubscription({
			endpoint: "https://push.example.com/route-health",
			p256dh: "x",
			auth: "y",
		});
		sender.markDelivered("https://push.example.com/route-health", 4242);

		const after = (await (await pushRoute.request("/key")).json()) as {
			subscriptions: number;
			lastSuccessAt: number | null;
		};
		expect(after).toMatchObject({ subscriptions: 1, lastSuccessAt: 4242 });
	});
});

describe("POST /subscribe", () => {
	it("stores a subscription", async () => {
		const res = await pushRoute.request("/subscribe", {
			method: "POST",
			body: JSON.stringify(SUBSCRIPTION),
		});
		expect(res.status).toBe(200);
		expect(
			((await res.json()) as { subscriptions: number }).subscriptions,
		).toBe(1);
		expect(sender.listSubscriptions()[0]?.endpoint).toBe(SUBSCRIPTION.endpoint);
	});

	it("is idempotent for the same endpoint rather than accumulating rows", async () => {
		for (let i = 0; i < 3; i += 1) {
			await pushRoute.request("/subscribe", {
				method: "POST",
				body: JSON.stringify(SUBSCRIPTION),
			});
		}
		expect(sender.subscriptionCount()).toBe(1);
	});

	it("updates the keys when a browser re-subscribes on the same endpoint", async () => {
		await pushRoute.request("/subscribe", {
			method: "POST",
			body: JSON.stringify(SUBSCRIPTION),
		});
		await pushRoute.request("/subscribe", {
			method: "POST",
			body: JSON.stringify({
				...SUBSCRIPTION,
				keys: { p256dh: "RotatedKey", auth: "RotatedAuth" },
			}),
		});
		expect(sender.listSubscriptions()[0]?.p256dh).toBe("RotatedKey");
	});

	it("rejects a malformed body", async () => {
		const res = await pushRoute.request("/subscribe", {
			method: "POST",
			body: JSON.stringify({ endpoint: "https://x.example" }),
		});
		expect(res.status).toBe(400);
		expect(sender.subscriptionCount()).toBe(0);
	});

	// The endpoint becomes a server-side `fetch` target, so these are SSRF
	// vectors rather than merely malformed rows.
	it.each([
		"file:///etc/passwd",
		"http://localhost:6379/",
		"http://169.254.169.254/latest/meta-data/",
		"not-a-url",
	])("rejects a non-HTTPS endpoint (%s)", async (endpoint) => {
		const res = await pushRoute.request("/subscribe", {
			method: "POST",
			body: JSON.stringify({ ...SUBSCRIPTION, endpoint }),
		});
		expect(res.status).toBe(400);
		expect(sender.subscriptionCount()).toBe(0);
	});
});

describe("POST /unsubscribe", () => {
	it("removes a stored subscription", async () => {
		await pushRoute.request("/subscribe", {
			method: "POST",
			body: JSON.stringify(SUBSCRIPTION),
		});
		const res = await pushRoute.request("/unsubscribe", {
			method: "POST",
			body: JSON.stringify({ endpoint: SUBSCRIPTION.endpoint }),
		});
		expect(res.status).toBe(200);
		expect(sender.subscriptionCount()).toBe(0);
	});

	it("rejects a body with no endpoint", async () => {
		const res = await pushRoute.request("/unsubscribe", {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});
});

describe("primeVapidKeys", () => {
	it("reuses the persisted keypair instead of rotating it", () => {
		const before = sender.vapidPublicKey();
		sender.resetVapidCacheForTests();
		sender.primeVapidKeys();
		// Rotation would silently invalidate every stored subscription.
		expect(sender.vapidPublicKey()).toBe(before);
	});
});
