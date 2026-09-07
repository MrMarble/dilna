import type { Repo, RepoStats, RepoSyncStatus } from "@dilna/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { repoManager } from "../repos/manager";

type ListResponse = { repos: Repo[] };
type OneResponse = { repo: Repo };

const cloneBodySchema = z.object({
	url: z.string().min(1),
	slug: z.string().min(1).optional(),
});

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

reposRoute.get("/:id/stats", async (c) => {
	const id = c.req.param("id");
	const repo = await repoManager.get(id);
	if (!repo) throw new HTTPException(404, { message: "repo not found" });
	try {
		const stats = await repoManager.stats(repo);
		const body: { stats: RepoStats } = { stats };
		return c.json(body);
	} catch (err) {
		const msg = err instanceof Error ? err.message : "stats failed";
		throw new HTTPException(500, { message: msg });
	}
});

reposRoute.post("/", zValidator("json", cloneBodySchema), async (c) => {
	const body = c.req.valid("json");
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

reposRoute.post("/:id/sync", async (c) => {
	const id = c.req.param("id");
	const repo = await repoManager.get(id);
	if (!repo) throw new HTTPException(404, { message: "repo not found" });
	try {
		const status = await repoManager.syncStatus(repo);
		const body: { status: RepoSyncStatus } = { status };
		return c.json(body);
	} catch (err) {
		const msg = err instanceof Error ? err.message : "sync failed";
		throw new HTTPException(500, { message: msg });
	}
});

reposRoute.delete("/:id", async (c) => {
	const id = c.req.param("id");
	await repoManager.delete(id);
	return c.json({ ok: true, id });
});
