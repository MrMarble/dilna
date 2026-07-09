import type { Repo } from "@dilna/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { repoManager } from "../repos/manager";

type ListResponse = { repos: Repo[] };
type OneResponse = { repo: Repo };
type CloneBody = { url: string; slug?: string };

export const reposRoute = new Hono();

reposRoute.get("/", async (c) => {
	const repos = await repoManager.list();
	const body: ListResponse = { repos };
	return c.json(body);
});

reposRoute.get("/:id", async (c) => {
	const id = c.req.param("id");
	const repo = await repoManager.get(id);
	if (!repo) throw new HTTPException(404, { message: "repo not found" });
	const body: OneResponse = { repo };
	return c.json(body);
});

reposRoute.post("/", async (c) => {
	const body = await c.req.json<CloneBody>();
	if (!body?.url) {
		throw new HTTPException(400, { message: "url is required" });
	}
	try {
		const repo = await repoManager.clone(body.url, body.slug);
		const res: OneResponse = { repo };
		return c.json(res, 201);
	} catch (err) {
		const msg = err instanceof Error ? err.message : "clone failed";
		throw new HTTPException(500, { message: msg });
	}
});

reposRoute.post("/:id/pull", async (c) => {
	const id = c.req.param("id");
	const repo = await repoManager.get(id);
	if (!repo) throw new HTTPException(404, { message: "repo not found" });
	try {
		await repoManager.pull(repo);
	} catch (err) {
		const msg = err instanceof Error ? err.message : "pull failed";
		throw new HTTPException(500, { message: msg });
	}
	const body: OneResponse = { repo };
	return c.json(body);
});

reposRoute.delete("/:id", async (c) => {
	const id = c.req.param("id");
	await repoManager.delete(id);
	return c.json({ ok: true, id });
});
