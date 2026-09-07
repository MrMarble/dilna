import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { bearerAuthMiddleware, hostAllowlistMiddleware } from "./security";

describe("hostAllowlistMiddleware", () => {
	function app(allowedHosts: string[]) {
		return new Hono()
			.use("*", hostAllowlistMiddleware(allowedHosts))
			.get("/x", (c) => c.text("ok"));
	}

	it("allows a request whose Host header is in the allowlist", async () => {
		const res = await app(["dilna.example.com"]).request("/x", {
			headers: { host: "dilna.example.com" },
		});
		expect(res.status).toBe(200);
	});

	it("rejects a request whose Host header isn't in the allowlist", async () => {
		const res = await app(["dilna.example.com"]).request("/x", {
			headers: { host: "attacker.example" },
		});
		expect(res.status).toBe(403);
	});

	it("rejects a request with no Host header", async () => {
		const res = await app(["dilna.example.com"]).request("/x");
		expect(res.status).toBe(403);
	});
});

describe("bearerAuthMiddleware", () => {
	function app(token: string) {
		return new Hono()
			.use("/api/*", bearerAuthMiddleware(token, "/api/health"))
			.get("/api/health", (c) => c.text("ok"))
			.get("/api/sessions", (c) => c.text("ok"));
	}

	it("allows a request with the correct bearer token", async () => {
		const res = await app("secret").request("/api/sessions", {
			headers: { authorization: "Bearer secret" },
		});
		expect(res.status).toBe(200);
	});

	it("rejects a request with a missing or wrong token", async () => {
		const missing = await app("secret").request("/api/sessions");
		expect(missing.status).toBe(401);

		const wrong = await app("secret").request("/api/sessions", {
			headers: { authorization: "Bearer nope" },
		});
		expect(wrong.status).toBe(401);
	});

	it("always allows the skip path, even without a token", async () => {
		const res = await app("secret").request("/api/health");
		expect(res.status).toBe(200);
	});
});
