import {
	expect,
	SEED_CHANGED_FILE,
	SEED_COMMIT_SUBJECT,
	test,
} from "./fixtures/test";

/**
 * The loaded state: a repo already cloned and a Session already created.
 *
 * This is the band `shell.spec.ts` can't reach. Everything there asserts on
 * chrome around an *empty* instance; these specs start from the state the app
 * is actually in for the whole of a user's session, and assert on the surfaces
 * that only exist once there's something to show — the breadcrumb, the
 * composer, the context panel's changed files and commits.
 *
 * The fixture comes from `e2e/server.mjs --seed`, which seeds a dedicated
 * instance over the API before the suite runs (see `fixtures/seed.mjs`). No
 * network and no live remote: the repo is cloned from a bare repo in the temp
 * dir. The empty instance keeps its own process and its own DB, so the
 * zero-state canaries in `shell.spec.ts` still test a genuinely empty app.
 *
 * Read-only by design. The seeded instance is shared by every spec in this
 * file (`workers: 1`), so a spec here must not create or delete Sessions —
 * that would leak into every later spec's view of the sidebar. Specs that need
 * to mutate state belong in their own file with their own instance.
 */

test.describe("loaded instance", () => {
	test("shows the seeded repo in the sidebar, with its session underneath", async ({
		app,
		seeded,
	}) => {
		// The seeded instance is not the empty state — the whole point of the
		// fixture is that this screen is gone.
		await expect(app.sidebar.emptyMessage).toBeHidden();
		await expect(app.sidebar.repo(seeded.repo.slug)).toBeVisible();

		// The session submenu only exists for the selected repo (repos are an
		// accordion), so this click is the user's path to it, not a workaround.
		await app.sidebar.repo(seeded.repo.slug).click();
		await expect(app.sidebar.session(seeded.sessionTitle)).toBeVisible();
	});

	test("resolves a deep link to the session and renders the chat shell", async ({
		app,
		seeded,
	}) => {
		await app.gotoSession(seeded.repo.slug, seeded.session.id);

		// URL is unchanged: a deep link that silently redirected would mean the
		// app couldn't address a Session by URL, which push notifications
		// (`?session=<id>`) depend on too.
		await expect(app.page).toHaveURL(
			new RegExp(`/${seeded.repo.slug}/${seeded.session.id}$`),
		);

		// Scoped to `main`: the same title also renders in the sidebar row, and
		// this assertion is about the chat column having landed on the Session.
		await expect(app.main.getByText(seeded.sessionTitle)).toBeVisible();
		await app.composer.expectReady();
	});

	test("enables New session once a repo is selected", async ({
		app,
		seeded,
	}) => {
		// The mirror image of shell.spec.ts's "disables New session until a repo
		// is selected": same control, the other branch.
		await app.sidebar.repo(seeded.repo.slug).click();
		await expect(app.sidebar.newSession).toBeEnabled();
	});

	test("shows the session's breadcrumb and agent badge in the header", async ({
		app,
		seeded,
	}) => {
		await app.gotoSession(seeded.repo.slug, seeded.session.id);

		await expect(app.chatHeader.agentBadge).toBeVisible();
		// Deleting a Session is a header control (desktop); its presence is what
		// distinguishes a loaded header from the empty-state one.
		await expect(app.chatHeader.deleteSession).toBeVisible();
	});
});

test.describe("context panel", () => {
	test("lists the worktree's changed files", async ({ app, seeded }) => {
		await app.gotoSession(seeded.repo.slug, seeded.session.id);

		await expect(
			app.contextPanel.sectionHeading("Changed files"),
		).toBeVisible();
		// The seed writes this file into the Session's worktree after the
		// worktree exists, so it is an uncommitted change — the panel's job.
		await expect(app.contextPanel.changedFile(SEED_CHANGED_FILE)).toBeVisible();
	});

	test("lists the repo's recent commits", async ({ app, seeded }) => {
		await app.gotoSession(seeded.repo.slug, seeded.session.id);

		await expect(
			app.contextPanel.sectionHeading("Recent commits"),
		).toBeVisible();
		await expect(app.contextPanel.commit(SEED_COMMIT_SUBJECT)).toBeVisible();
	});

	test("shows repository and session facts", async ({ app, seeded }) => {
		await app.gotoSession(seeded.repo.slug, seeded.session.id);

		const repository = app.contextPanel.section("Repository");
		await expect(repository).toBeVisible();
		await expect(repository.getByText(seeded.repo.slug)).toBeVisible();
		await expect(
			repository.getByText(seeded.repo.defaultBranch, { exact: true }),
		).toBeVisible();
		await expect(app.contextPanel.section("Current session")).toBeVisible();
	});

	test("collapses from the panel and reopens from the header", async ({
		app,
		seeded,
	}) => {
		await app.gotoSession(seeded.repo.slug, seeded.session.id);
		await expect(app.contextPanel.root).toBeVisible();

		await app.contextPanel.collapse.click();
		await expect(app.contextPanel.root).toBeHidden();

		// Collapsing removes the panel's own reopen affordance along with it, so
		// the header carries the way back (same shape as the sidebar's).
		await expect(app.contextPanel.headerExpand).toBeVisible();
		await app.contextPanel.headerExpand.click();
		await expect(app.contextPanel.root).toBeVisible();
	});

	test("survives a reload of the session route", async ({ app, seeded }) => {
		// A Session deep link renders chat + panel side by side; reloading that
		// URL must land in the same place. `App` derives `selectedRepo` by
		// matching the slug against the repo list, so a regression there shows
		// up as the panel vanishing on a cold load even though the in-app click
		// path still works.
		await app.gotoSession(seeded.repo.slug, seeded.session.id);
		await app.page.reload();

		await app.composer.expectReady();
		await expect(
			app.contextPanel.sectionHeading("Changed files"),
		).toBeVisible();
	});
});
