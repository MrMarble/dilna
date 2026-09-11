import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { parseCommitsLimit, sessionsRoute } from "./sessions";

describe("parseCommitsLimit", () => {
	it("passes through a valid limit", () => {
		expect(parseCommitsLimit("10")).toBe(10);
		expect(parseCommitsLimit("1")).toBe(1);
		expect(parseCommitsLimit("50")).toBe(50);
	});

	it("falls back to undefined for missing, non-numeric, or out-of-range input", () => {
		expect(parseCommitsLimit(undefined)).toBeUndefined();
		expect(parseCommitsLimit("")).toBeUndefined();
		expect(parseCommitsLimit("abc")).toBeUndefined();
		expect(parseCommitsLimit("0")).toBeUndefined();
		expect(parseCommitsLimit("-5")).toBeUndefined();
		expect(parseCommitsLimit("51")).toBeUndefined();
		expect(parseCommitsLimit("3.5")).toBeUndefined();
	});
});

// zod validation happens in the zValidator middleware, before the handler
// (and therefore the DB) is ever touched — so these can run with no DB
// fixture at all.
describe("sessionsRoute validation", () => {
	const app = new Hono().route("/", sessionsRoute);

	it("rejects POST / with no repoId", async () => {
		const res = await app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it("rejects POST / with an unrecognized agentType", async () => {
		const res = await app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ repoId: "abc", agentType: "claude" }),
		});
		expect(res.status).toBe(400);
	});

	it("rejects POST /:id/messages with no text", async () => {
		const res = await app.request("/some-id/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it("rejects POST /:id/messages with an empty text string", async () => {
		const res = await app.request("/some-id/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "" }),
		});
		expect(res.status).toBe(400);
	});

	it("rejects POST /:id/messages with whitespace-only text and no attachments", async () => {
		const res = await app.request("/some-id/messages", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "   ", attachmentIds: [] }),
		});
		expect(res.status).toBe(400);
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
		expect(res.status).toBe(400);
	});
});
