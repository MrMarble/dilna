import {
	type ComparisonResponse,
	type ComparisonView,
	createComparisonBodySchema,
} from "@dilna/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { RepoNotFoundError } from "../repos/manager";
import { InvalidModelError, type SessionManager } from "../sessions/manager";
import { validate } from "./factory";

/**
 * Model comparison (issue #250, ADR-0047). A Comparison is N ordinary
 * Sessions sharing a group id — there is no `comparisons` row to create, so
 * `POST` is the whole write side: create the arms, run the initial prompt on
 * each. `GET` re-reads a group's arms for the `/compare/<id>` route (the
 * deep-link/reload path; the creating client already has them in hand).
 */
export function createComparisonsRoute(deps: {
	sessions: SessionManager;
}): Hono {
	const comparisonsRoute = new Hono();

	comparisonsRoute.post(
		"/",
		validate("json", createComparisonBodySchema),
		async (c) => {
			const body = c.req.valid("json");
			let created: Awaited<ReturnType<SessionManager["createComparison"]>>;
			try {
				created = await deps.sessions.createComparison(
					body.repoId,
					body.prompt,
					body.models,
				);
			} catch (err) {
				if (err instanceof RepoNotFoundError) {
					throw new HTTPException(404, { message: err.message });
				}
				// A model the catalog doesn't know (or whose key is missing) is a
				// caller mistake, not a server failure — the manager validated it
				// before building anything, and rolled back any arms that landed.
				if (err instanceof InvalidModelError) {
					throw new HTTPException(400, { message: err.message });
				}
				const msg = err instanceof Error ? err.message : "create failed";
				throw new HTTPException(500, { message: msg });
			}
			// The schema demands ≥2 arms, so this can't fire — a guard, not a
			// branch: it keeps `first` type-honest and a manager regression (an
			// empty group) a clean 500 instead of a malformed envelope.
			const first = created.sessions[0];
			if (!first) {
				throw new HTTPException(500, {
					message: "comparison created with no arms",
				});
			}
			const comparison: ComparisonView = {
				id: created.groupId,
				repoId: body.repoId,
				createdAt: first.createdAt,
				sessions: created.sessions,
			};
			const res: ComparisonResponse = { comparison };
			return c.json(res, 201);
		},
	);

	comparisonsRoute.get("/:id", async (c) => {
		const sessions = await deps.sessions.getComparison(c.req.param("id"));
		const first = sessions?.[0];
		if (!first) {
			throw new HTTPException(404, { message: "comparison not found" });
		}
		const comparison: ComparisonView = {
			id: c.req.param("id"),
			repoId: first.repoId,
			createdAt: first.createdAt,
			sessions,
		};
		const res: ComparisonResponse = { comparison };
		return c.json(res);
	});

	return comparisonsRoute;
}
