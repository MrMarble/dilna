import { getDataDir, getDb } from "./db";
import { RepoManager } from "./repos/manager";
import { SessionManager } from "./sessions/manager";

/**
 * The server's composition root (issue #150).
 *
 * `RepoManager` and `SessionManager` used to be module-level singletons
 * (`export const repoManager = new RepoManager()`) built at import time with
 * no-arg constructors that reached for `getDb()`/`getDataDir()` internally.
 * That had two costs this module exists to remove:
 *
 * **Import-time construction vs. test setup.** A singleton constructed when
 * its module is first imported runs before a test can point
 * `DILNA_DATA_DIR` at a scratch directory, which forced lazy-initialization
 * workarounds (`SessionManager.hydrateRateLimits` was deferred to first read
 * purely to dodge this). Building both here, on demand, means construction
 * happens after the caller has decided what the data directory is.
 *
 * **A real import cycle.** `repos/manager.ts` imported `sessionManager` to
 * cascade-delete a Repo's Sessions, while `sessions/manager.ts` imported
 * `repoManager` to resolve a Session's Repo. The cycle was safe only by
 * convention — both sides deferred the reference into async method bodies,
 * so nothing observed a half-initialized module at evaluation time, and any
 * refactor that hoisted one of those reads to module scope would have broken
 * it silently. Now `repos/manager.ts` imports no session module at all: it
 * declares the narrow {@link SessionCascade} slice it needs and receives an
 * implementation here.
 *
 * The wiring order below is the one asymmetry worth knowing about.
 * `SessionManager` needs a `RepoManager` at construction, so repos is built
 * first; the Repo->Session cascade is then closed with `setSessions`. That
 * is a genuine mutual dependency, not an accident of layering — deleting a
 * Repo must delete its Sessions, and creating a Session must resolve its
 * Repo — so something has to be completed in a second step. Doing it in one
 * explicit place beats two modules importing each other's singleton.
 */
export interface ServerContext {
	repos: RepoManager;
	sessions: SessionManager;
}

/**
 * Build a fully-wired {@link ServerContext}. Defaults to the process-wide DB
 * handle and data directory; both are injectable so a test can build an
 * isolated pair against its own scratch state.
 */
export function createServerContext(
	opts: { db?: ReturnType<typeof getDb>; dataDir?: string } = {},
): ServerContext {
	const db = opts.db ?? getDb();
	const dataDir = opts.dataDir ?? getDataDir();

	const repos = new RepoManager({ db, dataDir });
	const sessions = new SessionManager({ db, repos });
	repos.setSessions(sessions);

	return { repos, sessions };
}
