/**
 * Repo slugs that a standalone view's URL path would shadow — a URL contract
 * *both* sides need.
 *
 * The web's router claims `/metrics`, `/settings`, `/skills`,
 * `/orchestrator` and `/compare` (issue #250's comparison view) as top-level
 * pages, so a Repo whose slug is one of those can
 * never be addressed: `/<slug>` parses straight back to the standalone view.
 * The web handled that by refusing to navigate to it — but the *server* knew
 * nothing about the list, so it would happily mint the slug in the first
 * place. Cloning `github.com/x/metrics` produced a Repo that appeared in the
 * sidebar and could never be opened (`App`'s `repoRoute` falls back to home).
 *
 * Living here, the server can feed the set into its slug-uniquing used-set and
 * pick `metrics-2` instead, and the web's `isReservedSlug` reads the same
 * constant rather than its own copy.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
	"metrics",
	"settings",
	"skills",
	"orchestrator",
	"compare",
]);

/** Whether a slug would be shadowed by a standalone view's path. */
export function isReservedSlug(slug: string): boolean {
	return RESERVED_SLUGS.has(slug);
}
