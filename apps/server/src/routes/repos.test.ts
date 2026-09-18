import type { Repo } from "@dilna/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/errors";
import type { RepoManager } from "../repos/manager";
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

const REPO: Repo = {
	id: "r1",
	slug: "acme/widgets",
	path: "/data/repos/acme-widgets",
	defaultBranch: "main",
	remoteUrl: "https://example.com/widgets.git",
	createdAt: 1_700_000_000,
};

/** A RepoManager stubbed down to what the `:id` routes touch. `get` resolves
 * `REPO` for its id and `undefined` for anything else, which is what makes the
 * 404 path below exercise `requireRepo` rather than a hand-rolled check. */
function stubRepos(overrides: Partial<RepoManager> = {}) {
	return {
		get: vi.fn(async (id: string) => (id === REPO.id ? REPO : undefined)),
		stats: vi.fn(async () => ({ fileCount: 3, languages: [] })),
		syncStatus: vi.fn(async () => ({ ahead: 0, behind: 2 })),
		pull: vi.fn(async () => {}),
		delete: vi.fn(async () => {}),
		...overrides,
	} as unknown as RepoManager;
}

function mountRepos(repos: RepoManager) {
	// Mounts the same `onError` as index.ts, so these assert the production
	// error envelope rather than Hono's bare text rendering (ADR-0039).
	return new Hono()
		.onError(errorHandler)
		.route("/", createReposRoute({ repos }));
}

// These cover the routes `requireRepo` guards (issue #231). Before it existed
// each handler repeated its own fetch-and-404; the risk now is a *mounting*
// mistake — a route registered outside the guarded sub-router silently fails
// open, and one registered inside it shadows a sibling. Both show up here.
describe("reposRoute :id resolution", () => {
	const guarded = [
		{ name: "GET /:id", path: `/${REPO.id}`, init: undefined },
		{ name: "GET /:id/stats", path: `/${REPO.id}/stats`, init: undefined },
		{
			name: "POST /:id/pull",
			path: `/${REPO.id}/pull`,
			init: { method: "POST" },
		},
		{
			name: "POST /:id/sync",
			path: `/${REPO.id}/sync`,
			init: { method: "POST" },
		},
	];

	for (const route of guarded) {
		it(`${route.name} 404s with the shared envelope for an unknown Repo`, async () => {
			const app = mountRepos(stubRepos());
			const res = await app.request(
				route.path.replace(REPO.id, "nope"),
				route.init,
			);
			expect(res.status).toBe(404);
			expect(await res.json()).toEqual({
				error: { message: "repo not found", status: 404 },
			});
		});

		it(`${route.name} reaches its handler for a known Repo`, async () => {
			const app = mountRepos(stubRepos());
			const res = await app.request(route.path, route.init);
			expect(res.status).toBe(200);
		});
	}

	it("resolves the Repo once per request, not once per handler", async () => {
		const repos = stubRepos();
		const app = mountRepos(repos);
		await app.request(`/${REPO.id}/stats`);
		expect(repos.get).toHaveBeenCalledTimes(1);
	});

	it("hands the resolved Repo to the manager, not just its id", async () => {
		const repos = stubRepos();
		const app = mountRepos(repos);
		await app.request(`/${REPO.id}/sync`, { method: "POST" });
		expect(repos.syncStatus).toHaveBeenCalledWith(REPO);
	});

	// DELETE is idempotent by design and deliberately sits *outside* the
	// guarded router: an already-gone Repo still satisfies the caller. Mounting
	// it behind `requireRepo` would turn this 200 into a 404.
	it("DELETE /:id stays 200 for an unknown Repo", async () => {
		const repos = stubRepos();
		const app = mountRepos(repos);
		const res = await app.request("/nope", { method: "DELETE" });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, id: "nope" });
		expect(repos.delete).toHaveBeenCalledWith("nope");
	});

	// GET / takes no `:id`; the guarded sub-router must not swallow it.
	it("GET / still lists without touching the guard", async () => {
		const repos = stubRepos({
			list: vi.fn(async () => [REPO]),
		} as Partial<RepoManager>);
		const app = mountRepos(repos);
		const res = await app.request("/");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ repos: [REPO] });
		expect(repos.get).not.toHaveBeenCalled();
	});
});
