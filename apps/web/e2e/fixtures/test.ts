import { test as base, expect } from "@playwright/test";
import { AppPage } from "./app";

/**
 * The suite's entry point: import `test`/`expect` from here, not from
 * `@playwright/test`, so every spec gets the page objects automatically.
 *
 * Specs should read: load a fixture, do something, assert the output. Any
 * selector or multi-step interaction belongs in a page object in `./app.ts`.
 */

type Fixtures = {
	/** The app shell, already loaded at `/` and confirmed rendered. */
	app: AppPage;
};

export const test = base.extend<Fixtures>({
	app: async ({ page }, use) => {
		const app = new AppPage(page);
		await app.goto();
		await use(app);
	},
});

export { expect };
