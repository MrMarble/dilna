import { commitsQuerySchema } from "@dilna/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/errors";
import type { SessionManager } from "../sessions/manager";
import { createSessionsRoute } from "./sessions";

// Was `parseCommitsLimit`, a hand-rolled parser; the bound now lives on
// `commitsQuerySchema` in @dilna/shared. Same contract: a junk or
// out-of-range `?limit=` degrades to undefined (so getRecentCommits applies
// its own default of 5) rather than erroring the request.
describe("commitsQuerySchema", () => {
	const limitOf = (limit?: string) =>
		commitsQuerySchema.parse(limit === undefined ? {} : { limit }).limit;

	it("passes through a valid limit", () => {
		expect(limitOf("10")).toBe(10);
		expect(limitOf("1")).toBe(1);
		expect(limitOf("50")).toBe(50);
	});

	it("falls back to undefined for missing, non-numeric, or out-of-range input", () => {
		expect(limitOf(undefined)).toBeUndefined();
		expect(limitOf("")).toBeUndefined();
		expect(limitOf("abc")).toBeUndefined();
		expect(limitOf("0")).toBeUndefined();
		expect(limitOf("-5")).toBeUndefined();
		expect(limitOf("51")).toBeUndefined();
		expect(limitOf("3.5")).toBeUndefined();
	});
});

// zod validation happens in the zValidator middleware, before the handler
// (and therefore the DB) is ever touched — so these can run with no DB
// fixture at all.
// The validation below rejects before any handler runs, so the managers
// are never actually touched — injection lets this file say that out loud
// with a cast, instead of depending on a real singleton (issue #150).
const noManagers = {
	repos: {} as never,
	sessions: {} as never,
};

describe("sessionsRoute validation", () => {
	const app = new Hono().route("/", createSessionsRoute(noManagers));

	it("rejects POST / with no repoId", async () => {
		const res = await app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(422);
	});

	it("rejects POST / with an unrecognized agentType", async () => {
		const res = await app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ repoId: "abc", agentType: "claude" }),
		});
		expect(res.status).toBe(422);
	});

	it("rejects POST /:id/messages with no text", async () => {
		const res = await app.request("/some-id/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(422);
	});

	it("rejects POST /:id/messages with an empty text string", async () => {
		const res = await app.request("/some-id/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "" }),
		});
		expect(res.status).toBe(422);
	});

	it("rejects POST /:id/messages with whitespace-only text and no attachments", async () => {
		const res = await app.request("/some-id/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "   ", attachmentIds: [] }),
		});
		expect(res.status).toBe(422);
	});

	// An attachment-only message ("look at this") is a real send, so empty text
	// must pass *validation*. It still fails downstream here — there's no DB
	// fixture, so the id resolves to nothing — but with the attachment
	// resolver's message, not the schema's, which is what distinguishes
	// "schema let it through" from "schema rejected empty text".
	it("accepts empty text when attachments are present", async () => {
		const res = await app.request("/some-id/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "", attachmentIds: ["att-1"] }),
		});
		expect(await res.text()).not.toContain(
			"a message needs text or at least one attachment",
		);
	});

	it("rejects POST /:id/messages with a malformed attachmentIds array", async () => {
		const res = await app.request("/some-id/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "hi", attachmentIds: [""] }),
		});
		expect(res.status).toBe(422);
	});

	// The queue endpoint shares the send's body schema (ADR-0033) — an
	// enqueue that would be an invalid send must be an invalid enqueue too,
	// or the queue becomes a validation bypass for the dispatch it turns into.
	it("rejects POST /:id/queue with no text and no attachments", async () => {
		const res = await app.request("/some-id/queue", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "   " }),
		});
		expect(res.status).toBe(422);
	});
});

/**
 * The `requireSession` seam (issue #204). The 404-on-unknown-`:id` rule used
 * to be three lines repeated in each handler; these tests pin it to the
 * middleware so a *new* endpoint mounted behind it is covered by construction,
 * and — just as importantly — pin the endpoints that deliberately stay
 * outside it, whose behaviour would silently change if someone "tidied up" by
 * mounting the guard blanket-style across `/:id/*`.
 */
describe("requireSession on sessions routes", () => {
	// `get` resolving null is the whole fixture: the middleware 404s before any
	// handler (and therefore any other manager method) is reached.
	function appWithNoSessions() {
		const sessions = {
			get: vi.fn().mockResolvedValue(null),
			delete: vi.fn().mockResolvedValue(undefined),
			requestStop: vi.fn().mockResolvedValue(undefined),
			removeQueuedMessage: vi.fn(),
			getMessages: vi.fn().mockResolvedValue([]),
		} as unknown as SessionManager;
		// Mounts the same `onError` as index.ts, so these assert the error shape
		// a real client actually receives rather than Hono's bare-HTTPException
		// default — which is text/plain and unreadable by `api/client.ts`.
		return {
			sessions,
			app: new Hono()
				.onError(errorHandler)
				.route("/", createSessionsRoute({ sessions, repos: {} as never })),
		};
	}

	it.each([
		["/missing"],
		["/missing/transcript"],
		["/missing/changed-files"],
		["/missing/commits"],
		["/missing/queue"],
		["/missing/artefacts"],
	])("404s GET %s for an unknown session", async (path) => {
		const { app } = appWithNoSessions();
		const res = await app.request(path);
		expect(res.status).toBe(404);
		await expect(res.json()).resolves.toEqual({
			error: { message: "session not found", status: 404 },
		});
	});

	it("404s POST /:id/attachments for an unknown session", async () => {
		const { app } = appWithNoSessions();
		const res = await app.request("/missing/attachments", { method: "POST" });
		expect(res.status).toBe(404);
	});

	// The guard fails closed: a handler behind it never runs for a missing
	// Session, so it cannot return a misleading empty result.
	it("does not reach the handler when the session is missing", async () => {
		const { app, sessions } = appWithNoSessions();
		await app.request("/missing/messages");
		expect(sessions.getMessages).toHaveBeenCalled();

		await app.request("/missing/changed-files");
		expect(sessions.getChangedFiles).toBeUndefined();
	});

	// These stay outside the middleware on purpose — an already-gone Session
	// still satisfies the caller's intent, so they must not start 404ing.
	it("keeps DELETE /:id idempotent for an unknown session", async () => {
		const { app, sessions } = appWithNoSessions();
		const res = await app.request("/missing", { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(sessions.delete).toHaveBeenCalledWith("missing");
	});

	it("keeps POST /:id/stop idempotent for an unknown session", async () => {
		const { app, sessions } = appWithNoSessions();
		const res = await app.request("/missing/stop", { method: "POST" });
		expect(res.status).toBe(200);
		expect(sessions.requestStop).toHaveBeenCalledWith("missing");
	});

	it("keeps DELETE /:id/queue/:queuedId idempotent for an unknown session", async () => {
		const { app, sessions } = appWithNoSessions();
		const res = await app.request("/missing/queue/q1", { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(sessions.removeQueuedMessage).toHaveBeenCalledWith("missing", "q1");
	});
});
