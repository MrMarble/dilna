import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { skillsRoute } from "./skills";

// zod validation runs in the zValidator middleware, before the handler (and
// therefore the DB/network) is ever touched — so these need no fixture.
describe("skillsRoute validation", () => {
	const app = new Hono().route("/", skillsRoute);

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

	it("rejects an enable toggle with no repoId", async () => {
		const res = await app.request("/owner/repo/skill/enabled", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ enabled: true }),
		});
		expect(res.status).toBe(400);
	});

	it("rejects an enable toggle with a non-boolean enabled", async () => {
		const res = await app.request("/owner/repo/skill/enabled", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ repoId: "r1", enabled: "yes" }),
		});
		expect(res.status).toBe(400);
	});

	it("returns an empty result set for a too-short search query", async () => {
		const res = await app.request("/search?q=a");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ results: [] });
	});
});
