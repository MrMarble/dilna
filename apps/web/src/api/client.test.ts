import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, api } from "./client";

/**
 * The client half of the error-envelope change. Before it, the server sent
 * `HTTPException` messages as text/plain and this module looked for a JSON
 * `message` key — so every server-authored message ("repo not found",
 * "a message needs text or at least one attachment") was replaced by a
 * generic "request failed (404)" before the user ever saw it.
 */
function mockFetch(status: number, body: unknown, asText = false) {
	const payload = asText ? String(body) : JSON.stringify(body);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(payload, { status })),
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("request() error handling", () => {
	it("surfaces the server's message from the error envelope", async () => {
		mockFetch(404, { error: { message: "repo not found", status: 404 } });

		await expect(api.repos.get("nope")).rejects.toThrow("repo not found");
	});

	it("carries fieldErrors through so a form can mark its inputs", async () => {
		mockFetch(422, {
			error: {
				message: "a message needs text or at least one attachment",
				status: 422,
				fieldErrors: { _: ["a message needs text or at least one attachment"] },
			},
		});

		const err = await api.sessions.send("s1", "   ").catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.status).toBe(422);
		expect(err.fieldErrors).toEqual({
			_: ["a message needs text or at least one attachment"],
		});
	});

	it("falls back to a generic message for a non-envelope body", async () => {
		// e.g. a proxy or load balancer erroring before the request reaches dilna.
		mockFetch(502, "<html>Bad Gateway</html>", true);

		const err = await api.repos.list().catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.message).toBe("request failed (502)");
	});

	it("returns the parsed body on success", async () => {
		mockFetch(200, { repos: [] });
		await expect(api.repos.list()).resolves.toEqual({ repos: [] });
	});
});

/**
 * Response envelopes are shared types now (ADR-0040). These cover the runtime
 * half: the previously-missing fields survive `request()`'s parse and reach
 * the caller, rather than being stripped on the way through.
 *
 * They do **not** catch a hand-narrowed client type — the body comes from the
 * `fetch` mock below, so the field is present at runtime whatever the type
 * says. That is `client.contract.test-d.ts`'s job, and the reason it exists.
 */
describe("response envelopes reach callers whole", () => {
	it("keeps contextUsage on a freshly created Session", async () => {
		// The server has always sent this; the client used to type
		// `POST /api/sessions` as `{ session }` only.
		mockFetch(201, { session: { id: "s1" }, contextUsage: null });
		const res = await api.sessions.create("r1");
		expect(res).toHaveProperty("contextUsage", null);
	});

	it("keeps push delivery health alongside the key", async () => {
		// `subscriptions`/`lastSuccessAt` are what the push route's doc comment
		// calls the first thing to check when notifications aren't arriving.
		mockFetch(200, {
			publicKey: "BKey",
			configured: true,
			subscriptions: 2,
			lastSuccessAt: 4242,
		});
		const res = await api.push.key();
		expect(res).toMatchObject({ subscriptions: 2, lastSuccessAt: 4242 });
	});
});
