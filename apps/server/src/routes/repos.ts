import {
	cloneRepoBodySchema,
	createWorkspaceBodySchema,
	type ListReposResponse,
	type OkIdResponse,
	type RepoResponse,
	type RepoStatsResponse,
	type RepoSyncResponse,
} from "@dilna/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { type RepoEnv, requireRepo } from "../middleware/requireRepo";
import type { RepoManager } from "../repos/manager";
import { validate } from "./factory";

// Response envelopes come from `@dilna/shared` so the web client's call sites
// type against the same declaration (ADR-0040) — they used to be route-local
// `ListResponse`/`OneResponse` aliases the client restated by hand.

export function createReposRoute(deps: { repos: RepoManager }): Hono {
	const reposRoute = new Hono();

	// Endpoints whose `:id` must name an existing Repo. `requireRepo` resolves
	// it once and 404s otherwise, so the handlers below read `c.get("repo")`
	// instead of repeating the same fetch-and-404 preamble four times.
	// `POST /` (no id yet) and `DELETE /:id` (idempotent by design) are mounted
	// on `reposRoute` directly; `requireRepo`'s doc comment says why.
	const guarded = new Hono<RepoEnv>();
	guarded.use("/:id", requireRepo(deps.repos));
	guarded.use("/:id/*", requireRepo(deps.repos));

	reposRoute.get("/", async (c) => {
		const repos = await deps.repos.list();
		const body: ListReposResponse = { repos };
		return c.json(body);
	});

	guarded.get("/:id", (c) => {
		const body: RepoResponse = { repo: c.get("repo") };
		return c.json(body);
	});

	guarded.get("/:id/stats", async (c) => {
		try {
			const stats = await deps.repos.stats(c.get("repo"));
			const body: RepoStatsResponse = { stats };
			return c.json(body);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "stats failed";
			throw new HTTPException(500, { message: msg });
		}
	});

	reposRoute.post("/", validate("json", cloneRepoBodySchema), async (c) => {
		const body = c.req.valid("json");
		try {
			const repo = await deps.repos.clone(body.url, body.slug);
			const res: RepoResponse = { repo };
			return c.json(res, 201);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "clone failed";
			throw new HTTPException(500, { message: msg });
		}
	});

	// Registered on `reposRoute` ahead of the `guarded` mount, so this handler
	// answers before `requireRepo` could read "workspace" as a Repo id.
	reposRoute.post(
		"/workspace",
		validate("json", createWorkspaceBodySchema),
		async (c) => {
			const body = c.req.valid("json");
			try {
				const repo = await deps.repos.createWorkspace(body.name);
				const res: RepoResponse = { repo };
				return c.json(res, 201);
			} catch (err) {
				const msg =
					err instanceof Error ? err.message : "workspace creation failed";
				throw new HTTPException(500, { message: msg });
			}
		},
	);

	guarded.post("/:id/pull", async (c) => {
		const repo = c.get("repo");
		try {
			await deps.repos.pull(repo);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "pull failed";
			throw new HTTPException(500, { message: msg });
		}
		const body: RepoResponse = { repo };
		return c.json(body);
	});

	guarded.post("/:id/sync", async (c) => {
		try {
			const status = await deps.repos.syncStatus(c.get("repo"));
			const body: RepoSyncResponse = { status };
			return c.json(body);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "sync failed";
			throw new HTTPException(500, { message: msg });
		}
	});

	// Idempotent: deleting an already-gone Repo is still a success, so this one
	// stays outside `guarded` — see `requireRepo`'s doc comment.
	reposRoute.delete("/:id", async (c) => {
		const id = c.req.param("id");
		await deps.repos.delete(id);
		const body: OkIdResponse = { ok: true, id };
		return c.json(body);
	});

	reposRoute.route("/", guarded);
	return reposRoute;
}
