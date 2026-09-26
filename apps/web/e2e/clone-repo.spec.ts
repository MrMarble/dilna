import { expect, test } from "./fixtures/test";

/**
 * The clone dialog's form behaviour. Stops short of actually cloning: that
 * needs network and a real git remote, which would make the suite slow and
 * flaky. The submit-and-succeed path belongs in a separate, explicitly-tagged
 * spec that can be skipped offline.
 */

test.describe("clone repository dialog", () => {
	test("opens from the empty-state call to action", async ({ app }) => {
		const dialog = await app.openCloneDialog();
		await expect(dialog.gitUrl).toBeVisible();
	});

	test("opens from the sidebar + button", async ({ app }) => {
		await app.sidebar.newRepo.click();
		await app.cloneDialog.expectOpen();
	});

	test("focuses the Git URL field on open", async ({ app }) => {
		const dialog = await app.openCloneDialog();
		await expect(dialog.gitUrl).toBeFocused();
	});

	test("keeps submit disabled until a URL is entered", async ({ app }) => {
		const dialog = await app.openCloneDialog();
		await expect(dialog.submit).toBeDisabled();

		await dialog.gitUrl.fill("git@github.com:owner/repo.git");
		await expect(dialog.submit).toBeEnabled();
	});

	test("treats a whitespace-only URL as empty", async ({ app }) => {
		const dialog = await app.openCloneDialog();
		await dialog.gitUrl.fill("   ");
		await expect(dialog.submit).toBeDisabled();
	});

	test("closes via the close button", async ({ app }) => {
		const dialog = await app.openCloneDialog();
		await dialog.close.click();
		await dialog.expectClosed();
	});

	test("closes on Escape", async ({ app }) => {
		const dialog = await app.openCloneDialog();
		await app.page.keyboard.press("Escape");
		await dialog.expectClosed();
	});

	test("accepts an optional name", async ({ app }) => {
		const dialog = await app.openCloneDialog();
		await dialog.name.fill("my-repo");
		await expect(dialog.name).toHaveValue("my-repo");
	});

	// Stops short of creating one, like the clone specs above: this instance is
	// shared, and a new Repo would end the empty state every other spec here
	// relies on. RepoManager's tests cover the creation itself.
	test("keeps the workspace button disabled until a name is entered", async ({
		app,
	}) => {
		const dialog = await app.openCloneDialog();
		await expect(dialog.createWorkspace).toBeDisabled();

		await dialog.name.fill("   ");
		await expect(dialog.createWorkspace).toBeDisabled();

		// No Git URL needed — the name is the only input an empty workspace has.
		await dialog.name.fill("my-idea");
		await expect(dialog.createWorkspace).toBeEnabled();
		await expect(dialog.submit).toBeDisabled();
	});
});
