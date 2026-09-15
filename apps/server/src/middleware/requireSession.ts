import type { Session } from "@dilna/shared";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type { SessionManager } from "../sessions/manager";

/**
 * Context variables set by {@link requireSession} (issue #204).
 *
 * Routes that mount the middleware type their `Hono` instance with this so
 * `c.get("session")` is a non-nullable `Session` in the handler — the whole
 * point of hoisting the check is that the handler no longer has to consider
 * the missing case, and the type should say so.
 */
export type SessionEnv = { Variables: { session: Session } };

/**
 * Resolve `:id` to a Session or fail the request with a 404.
 *
 * Mounted on the sub-paths of `routes/sessions.ts` that previously each
 * opened with the same fetch-and-404 preamble. The existence rule now has one
 * home, and a new endpoint mounted behind it inherits the 404 instead of
 * re-deriving it — forgetting the check used to fail *open*, running the
 * handler against a nonexistent Session and returning a misleading empty
 * result rather than a 404.
 *
 * Deliberately not mounted blanket-style across every `/:id/*` route: several
 * endpoints must keep their current behaviour and would change meaning behind
 * it. `DELETE /:id`, `POST /:id/stop` and `DELETE /:id/queue/:queuedId` are
 * idempotent by design (an already-gone Session is still a success — the
 * caller's intent is satisfied), and `POST /:id/messages`/`POST /:id/queue`
 * derive their 404 from `SessionNotFoundError` raised *inside*
 * `beginTurn`/`enqueueMessage`, which is load-bearing: ADR-0016 §2 requires no
 * `await` between that check and the turn claim, and a pre-handler lookup
 * would reintroduce exactly the gap the claim closes. Those routes are mounted
 * outside this middleware on purpose; see `createSessionsRoute`.
 */
export function requireSession(sessions: SessionManager): MiddlewareHandler {
	return async (c, next) => {
		const session = await sessions.get(c.req.param("id") ?? "");
		if (!session) {
			throw new HTTPException(404, { message: "session not found" });
		}
		c.set("session", session);
		await next();
	};
}
