import type { Repo } from "@dilna/shared";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { RepoManager } from "../repos/manager";

/**
 * Context variables set by {@link requireRepo}.
 *
 * The Repo-side twin of `SessionEnv`: routes that mount the middleware type
 * their `Hono` instance with this so `c.get("repo")` is a non-nullable `Repo`
 * in the handler. Hoisting the check is only worth it if the handler stops
 * having to consider the missing case, and the type should say so.
 */
export type RepoEnv = { Variables: { repo: Repo } };

/**
 * Resolve a Repo id to a Repo or fail the request with a 404.
 *
 * `requireSession` (issue #204) did this for Sessions; the same fetch-and-404
 * preamble was still repeated four times in `routes/repos.ts` and twice in
 * `routes/skills.ts` (issue #231). The existence rule now has one home, and a
 * new endpoint mounted behind it inherits the 404 instead of re-deriving it —
 * forgetting the check fails *open*, running the handler against a
 * nonexistent Repo.
 *
 * The id's location is a parameter because it genuinely varies: `repos.ts`
 * uses `:id`, `skills.ts` uses `:repoId`. `POST /skills/:id/enabled` is
 * deliberately *not* mounted behind this — its repo id arrives in the
 * validated JSON body rather than the path, so there is no param to read
 * before the body is parsed, and it keeps its inline check.
 *
 * Deliberately not mounted blanket-style across `repos.ts`'s `/:id/*` either.
 * `DELETE /:id` is idempotent by design (`RepoManager.delete` no-ops on an
 * unknown id, and an already-gone Repo still satisfies the caller's intent),
 * so putting it behind this would turn a 200 into a 404 — a behaviour change,
 * not a refactor. It stays mounted outside; see `createReposRoute`.
 */
export function requireRepo(
	repos: RepoManager,
	param = "id",
): MiddlewareHandler {
	return async (c, next) => {
		const repo = await repos.get(c.req.param(param) ?? "");
		if (!repo) {
			throw new HTTPException(404, { message: "repo not found" });
		}
		c.set("repo", repo);
		await next();
	};
}
