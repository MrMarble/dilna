import { type ApiErrorBody, isApiErrorBody } from "@dilna/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validate } from "../routes/factory";
import { errorHandler, notFoundHandler } from "./errors";

/**
 * The envelope exists because the server previously emitted four
 * incompatible error shapes and the web client could read none of them —
 * `HTTPException` in particular renders as text/plain, so a real message
 * like "repo not found" reached the UI as "request failed (404)". These
 * assert the shape is now uniform and, crucially, *parseable by the client*
 * (`isApiErrorBody` is the same guard `api/client.ts` narrows with).
 */
function makeApp() {
	const app = new Hono();
	app.onError(errorHandler);

	app.get("/boom", () => {
		throw new HTTPException(404, { message: "repo not found" });
	});
	app.get("/unexpected", () => {
		throw new Error("a filesystem path or key fragment might be in here");
	});
	app.get("/bare-zod", () => {
		z.object({ name: z.string() }).parse({});
		return new Response("unreachable");
	});
	app.post(
		"/validated",
		validate("json", z.object({ name: z.string().min(1), age: z.number() })),
		(c) => c.json(c.req.valid("json")),
	);
	app.all("/api/*", notFoundHandler);
	return app;
}

const jsonPost = (body: unknown) => ({
	method: "POST",
	headers: { "Content-Type": "application/json" },
	body: JSON.stringify(body),
});

/** Assert-and-narrow, so each test can read `.error` without re-casting. */
async function errorBody(res: Response): Promise<ApiErrorBody> {
	const body: unknown = await res.json();
	expect(isApiErrorBody(body)).toBe(true);
	return body as ApiErrorBody;
}

describe("error envelope", () => {
	it("renders HTTPException as JSON the client can read, not text/plain", async () => {
		const res = await makeApp().request("/boom");
		expect(res.status).toBe(404);
		expect(res.headers.get("content-type")).toContain("application/json");

		// The regression this whole change exists to fix: before, the client
		// fell back to a generic "request failed (404)" because it could not
		// find a message here.
		expect(await errorBody(res)).toEqual({
			error: { message: "repo not found", status: 404 },
		});
	});

	it("does not leak an unexpected error's message to the client", async () => {
		const res = await makeApp().request("/unexpected");
		expect(res.status).toBe(500);
		const body = await errorBody(res);
		expect(body.error.message).toBe("internal server error");
		expect(JSON.stringify(body)).not.toContain("filesystem path");
	});

	it("turns a ZodError thrown outside a validator into a 422, not a 500", async () => {
		const res = await makeApp().request("/bare-zod");
		expect(res.status).toBe(422);
		expect((await errorBody(res)).error.fieldErrors).toEqual({
			name: ["Required"],
		});
	});

	it("returns the envelope for an unmatched /api path", async () => {
		const res = await makeApp().request("/api/nope");
		expect(res.status).toBe(404);
		expect(isApiErrorBody(await res.json())).toBe(true);
	});
});

describe("validate()", () => {
	it("rejects an invalid body with 422 and per-field errors", async () => {
		const res = await makeApp().request(
			"/validated",
			jsonPost({ name: "", age: "not a number" }),
		);
		expect(res.status).toBe(422);

		// Both fields reported at once, so a form can mark every offending
		// input rather than surfacing them one reload at a time.
		const body = await errorBody(res);
		expect(Object.keys(body.error.fieldErrors ?? {}).sort()).toEqual([
			"age",
			"name",
		]);
	});

	it("surfaces a form-level refinement under `_`", async () => {
		const app = new Hono();
		app.onError(errorHandler);
		app.post(
			"/refined",
			validate(
				"json",
				z
					.object({ text: z.string(), ids: z.array(z.string()).optional() })
					.refine((b) => b.text.trim().length > 0 || b.ids?.length, {
						message: "a message needs text or at least one attachment",
					}),
			),
			(c) => c.json({ ok: true }),
		);

		const res = await app.request("/refined", jsonPost({ text: "   " }));
		expect(res.status).toBe(422);
		const body = await errorBody(res);
		// A `.refine()` on the object has no field to attach to; without the `_`
		// bucket these messages would vanish from the response entirely.
		expect(body.error.fieldErrors?._).toEqual([
			"a message needs text or at least one attachment",
		]);
		expect(body.error.message).toBe(
			"a message needs text or at least one attachment",
		);
	});

	it("passes a valid body through to the handler", async () => {
		const res = await makeApp().request(
			"/validated",
			jsonPost({ name: "dilna", age: 1 }),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ name: "dilna", age: 1 });
	});
});
