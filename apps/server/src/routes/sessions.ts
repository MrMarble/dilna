import type { SessionView } from "@dilna/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { sessionManager } from "../sessions/manager";

type ListResponse = { sessions: SessionView[] };
type OneResponse = { session: SessionView };
type CreateBody = { repoId: string };

export const sessionsRoute = new Hono();

sessionsRoute.get("/", async (c) => {
	const repoId = c.req.query("repoId");
	if (!repoId) {
		throw new HTTPException(400, { message: "repoId query param is required" });
	}
	const sessions = await sessionManager.listByRepo(repoId);
	const body: ListResponse = { sessions };
	return c.json(body);
});

sessionsRoute.get("/:id", async (c) => {
	const id = c.req.param("id");
	const session = await sessionManager.getView(id);
	if (!session) throw new HTTPException(404, { message: "session not found" });
	const body: OneResponse = { session };
	return c.json(body);
});

sessionsRoute.post("/", async (c) => {
	const body = await c.req.json<CreateBody>();
	if (!body?.repoId) {
		throw new HTTPException(400, { message: "repoId is required" });
	}
	try {
		const session = await sessionManager.create(body.repoId);
		const res: OneResponse = { session };
		return c.json(res, 201);
	} catch (err) {
		const msg = err instanceof Error ? err.message : "create failed";
		throw new HTTPException(500, { message: msg });
	}
});

sessionsRoute.delete("/:id", async (c) => {
	const id = c.req.param("id");
	await sessionManager.delete(id);
	return c.json({ ok: true, id });
});
