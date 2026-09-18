import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createReposRoute } from "./repos";

// zod validation happens in the zValidator middleware, before the handler
// (and therefore the DB/git) is ever touched — so these can run with no DB
// fixture at all.
// The validation below rejects before any handler runs, so the managers
// are never actually touched — injection lets this file say that out loud
// with a cast, instead of depending on a real singleton (issue #150).
const noManagers = {
	repos: {} as never,
	sessions: {} as never,
};

describe("reposRoute validation", () => {
	const app = new Hono().route("/", createReposRoute(noManagers));

	it("rejects POST / with no url", async () => {
		const res = await app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(422);
	});

	it("rejects POST / with an empty url", async () => {
		const res = await app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url: "" }),
		});
		expect(res.status).toBe(422);
	});

	it("rejects POST / with an empty slug", async () => {
		const res = await app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url: "https://example.com/repo.git", slug: "" }),
		});
		expect(res.status).toBe(422);
	});
});
