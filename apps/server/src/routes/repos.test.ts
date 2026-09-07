import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { reposRoute } from "./repos";

// zod validation happens in the zValidator middleware, before the handler
// (and therefore the DB/git) is ever touched — so these can run with no DB
// fixture at all.
describe("reposRoute validation", () => {
	const app = new Hono().route("/", reposRoute);

	it("rejects POST / with no url", async () => {
		const res = await app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it("rejects POST / with an empty url", async () => {
		const res = await app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url: "" }),
		});
		expect(res.status).toBe(400);
	});

	it("rejects POST / with an empty slug", async () => {
		const res = await app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url: "https://example.com/repo.git", slug: "" }),
		});
		expect(res.status).toBe(400);
	});
});
