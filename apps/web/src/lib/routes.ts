/**
 * The app's URL contract, in one place.
 *
 * dilna deliberately has no router dependency (see PR #68): navigation is the
 * History API plus `popstate`. What that PR left implicit — and what made the
 * Metrics/Settings views behave like modals rather than pages — is that there
 * was no single representation of "where am I". `App` kept a `view` state
 * *alongside* `selectedRepoId`/`selectedSessionId`, and each call site pushed
 * its own path string, so the two could (and did) drift apart: opening Metrics
 * set `view` but left the selection alone, and selecting a session updated the
 * selection but left `view` on "metrics", which rendered as a stuck overlay.
 *
 * So: a `Route` is the *only* description of the current location. `parseRoute`
 * turns a pathname into one, `routePath` turns one back into a pathname, and
 * `App` derives every bit of view state from the route it's holding. Nothing
 * else pushes paths by hand.
 *
 * The shapes:
 *   /                              → { kind: "home" }
 *   /metrics                       → { kind: "metrics" }
 *   /settings                      → { kind: "settings" }
 *   /orchestrator                  → { kind: "orchestrator", sessionId: null }
 *   /orchestrator/<session-id>     → { kind: "orchestrator", sessionId }
 *   /<repo-slug>                   → { kind: "repo", repoSlug, sessionId: null }
 *   /<repo-slug>/<session-id>      → { kind: "repo", repoSlug, sessionId }
 *
 * Orchestrator Sessions are global rather than repo-scoped (ADR-0021), so they
 * get a top-level segment instead of nesting under the hidden meta-repo they
 * technically belong to — the same treatment Metrics and Settings get.
 */
export type Route =
	| { kind: "home" }
	| { kind: "metrics" }
	| { kind: "settings" }
	| { kind: "orchestrator"; sessionId: string | null }
	| { kind: "repo"; repoSlug: string; sessionId: string | null };

/** Top-level segments claimed by standalone views, and therefore never
 * interpretable as a repo slug. */
const RESERVED_SEGMENTS = new Set(["metrics", "settings", "orchestrator"]);

export function parseRoute(pathname: string): Route {
	const [first, second] = pathname.split("/").filter(Boolean);
	if (!first) return { kind: "home" };
	if (first === "metrics") return { kind: "metrics" };
	if (first === "settings") return { kind: "settings" };
	if (first === "orchestrator")
		return { kind: "orchestrator", sessionId: second ?? null };
	return { kind: "repo", repoSlug: first, sessionId: second ?? null };
}

export function routePath(route: Route): string {
	switch (route.kind) {
		case "home":
			return "/";
		case "metrics":
			return "/metrics";
		case "settings":
			return "/settings";
		case "orchestrator":
			return route.sessionId
				? `/orchestrator/${route.sessionId}`
				: "/orchestrator";
		case "repo":
			return route.sessionId
				? `/${route.repoSlug}/${route.sessionId}`
				: `/${route.repoSlug}`;
	}
}

/** A repo slug that would be shadowed by a standalone view's path can't be
 * addressed as `/<slug>`; callers fall back to `/` rather than pushing a URL
 * that would parse back as Metrics/Settings/Orchestrator on reload. */
export function isReservedSlug(slug: string): boolean {
	return RESERVED_SEGMENTS.has(slug);
}
