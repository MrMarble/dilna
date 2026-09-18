import { type APIRequestContext, test as base, expect } from "@playwright/test";
import { AppPage } from "./app";
import { SEED_REPO_SLUG } from "./seed.mjs";

/**
 * The suite's entry point: import `test`/`expect` from here, not from
 * `@playwright/test`, so every spec gets the page objects automatically.
 *
 * Specs should read: load a fixture, do something, assert the output. Any
 * selector or multi-step interaction belongs in a page object in `./app.ts`.
 */

/** A Repo as it crosses the wire (only the fields these specs read). */
type Repo = { id: string; slug: string; defaultBranch: string };
/** A Session as it crosses the wire. `title` is the display name the sidebar
 * and header render. */
type Session = { id: string; repoId: string; title: string };

/**
 * The seeded instance `e2e/server.mjs --seed` sets up before any spec runs:
 * one repo cloned from a local bare remote, with one Session (issue #238).
 *
 * Resolved over the API from the spec side rather than published as ids by the
 * seed script, because those ids are only knowable through the same endpoints a
 * real client would use — and a spec that reads them back that way also checks
 * that the seeded state is actually *visible* to the app, which is a
 * precondition for every assertion built on it.
 *
 * Read-only: nothing here mutates the seeded instance. Specs that need to
 * change state (creating a Session, say) must build their own state and clean
 * up, since the instance is shared by every spec using this fixture.
 */
export type SeededInstance = {
	repo: Repo;
	session: Session;
	/** The Session's title, e.g. `Session aB3x` — the string the sidebar and
	 * header render, and the one a spec should assert on rather than the id. */
	sessionTitle: string;
};

type Fixtures = {
	/** The app shell, already loaded at `/` and confirmed rendered. */
	app: AppPage;
	/** The loaded instance: repo cloned, Session created. Only available on
	 * the `seeded` project — see playwright.config.ts. */
	seeded: SeededInstance;
};

/** Resolve the seeded Repo + Session over the API. Runs against the same
 * server the browser will hit, via Playwright's `request` fixture so the
 * baseURL (per-project) is shared. */
async function resolveSeeded(
	request: APIRequestContext,
): Promise<SeededInstance> {
	const reposRes = await request.get("/api/repos");
	expect(
		reposRes.ok(),
		"GET /api/repos should succeed on the seeded instance",
	).toBeTruthy();
	const { repos } = (await reposRes.json()) as { repos: Repo[] };

	const repo = repos.find((r) => r.slug === SEED_REPO_SLUG);
	expect(
		repo,
		`the seeded repo "${SEED_REPO_SLUG}" should exist — is this spec running on the ` +
			"`seeded` project (see playwright.config.ts's testMatch)? A run pointed at an " +
			"unseeded instance via PLAYWRIGHT_BASE_URL will fail here.",
	).toBeTruthy();

	const sessionsRes = await request.get(
		`/api/sessions?repoId=${encodeURIComponent(repo?.id ?? "")}`,
	);
	expect(sessionsRes.ok()).toBeTruthy();
	const { sessions } = (await sessionsRes.json()) as { sessions: Session[] };
	expect(
		sessions.length,
		"the seeded repo should have at least one Session",
	).toBeGreaterThan(0);

	const session = sessions[0];
	if (!repo || !session) {
		// Unreachable given the `expect`s above; present so the types narrow
		// without a non-null assertion in the return value.
		throw new Error("seed fixture: repo or session missing");
	}

	return { repo, session, sessionTitle: session.title };
}

export const test = base.extend<Fixtures>({
	app: async ({ page }, use) => {
		const app = new AppPage(page);
		await app.goto();
		await use(app);
	},

	seeded: async ({ request }, use) => {
		await use(await resolveSeeded(request));
	},
});

export {
	SEED_CHANGED_FILE,
	SEED_COMMIT_SUBJECT,
	SEED_REPO_SLUG,
} from "./seed.mjs";
export { expect };
