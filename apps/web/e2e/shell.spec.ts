import { expect, test } from "./fixtures/test";

/**
 * The app shell renders and is navigable. These are the regression canaries:
 * if the server/client wiring breaks, or the SPA fails to mount, these fail
 * before any feature test gets a chance to.
 */

test.describe("app shell", () => {
	test("serves the SPA and mounts the client", async ({ app }) => {
		await expect(app.page).toHaveTitle("dilna");
		await expect(app.main).toBeVisible();
	});

	test("shows the empty state when no repos are cloned", async ({ app }) => {
		await expect(app.emptyStateHeading).toBeVisible();
		await expect(
			app.page.getByText("self-hosted workspace for AI coding agents"),
		).toBeVisible();
		await expect(app.cloneRepoCta).toBeVisible();
	});

	test("prompts for a repo in the sidebar too", async ({ app }) => {
		await expect(app.sidebar.emptyMessage).toBeVisible();
	});

	test("disables New session until a repo is selected", async ({ app }) => {
		await expect(app.sidebar.newSession).toBeDisabled();
	});

	test("loads with no console errors", async ({ page }) => {
		const errors: string[] = [];
		page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
		page.on("pageerror", (e) => errors.push(e.message));

		await page.goto("/");
		await expect(page.getByRole("main")).toBeVisible();

		expect(errors).toEqual([]);
	});
});

test.describe("navigation", () => {
	for (const view of ["Metrics", "Skills", "Settings"] as const) {
		test(`reaches ${view} from the sidebar`, async ({ app }) => {
			await app.navigateTo(view);
			// Navigating updates the URL even though there's no router library,
			// so a wiring regression here would break deep links and reloads.
			await expect(app.page).toHaveURL(new RegExp(`/${view.toLowerCase()}$`));
		});

		test(`serves ${view} on a cold load of its URL`, async ({ app }) => {
			await app.goto(`/${view.toLowerCase()}`);
			await expect(app.heading(view)).toBeVisible();
		});
	}

	test("redirects an unknown repo slug home", async ({ app }) => {
		await app.goto("/no-such-repo");
		await expect(app.emptyStateHeading).toBeVisible();
		await expect(app.page).toHaveURL(/\/$/);
	});
});
