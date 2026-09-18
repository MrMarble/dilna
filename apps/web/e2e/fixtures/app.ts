import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Page objects for dilna's app shell.
 *
 * Every selector in the suite lives here, so a UI change is a one-file fix
 * rather than a sweep across specs. Locators are role/label/text based, never
 * CSS paths or nth-child — restyling or re-nesting the markup must not break
 * a test, but removing an accessible name should.
 *
 * Icon-only controls are addressed by `getByRole(..., { name })`, which matches
 * the accessible name rather than the `title` tooltip: the two are separate
 * attributes (issue #223), so a tooltip reword no longer breaks a spec.
 */

/** The left-hand `<aside>`: repo/session navigation and the app-level views. */
export class SidebarObject {
	readonly root: Locator;

	constructor(page: Page) {
		// Two unnamed `complementary` landmarks can coexist (sidebar and context
		// panel), so `getByRole("complementary")` alone is ambiguous. The collapse
		// control is unique to the sidebar, which pins down which aside this is.
		this.root = page.locator("aside").filter({
			has: page.getByRole("button", { name: "Collapse sidebar" }),
		});
	}

	/** Zero state, shown when no repos have been cloned yet. */
	get emptyMessage(): Locator {
		return this.root.getByText("No repos. Click + to clone one.");
	}

	/**
	 * The accessible name carries the keyboard hint (`New session ⌘K` on mac,
	 * `Ctrl K` elsewhere) because the shortcut span is only `display:none` below
	 * the md breakpoint. Matching on the prefix keeps this platform-agnostic.
	 */
	get newSession(): Locator {
		return this.root.getByRole("button", { name: /New session/ });
	}

	/** Icon-only (`+`). */
	get newRepo(): Locator {
		return this.root.getByRole("button", { name: "New repository" });
	}

	/** Icon-only (refresh). */
	get refreshRepos(): Locator {
		return this.root.getByRole("button", {
			name: "Pull latest default-branch changes",
		});
	}

	/** A repo row, addressed by the slug the user sees. */
	repo(slug: string): Locator {
		return this.root.getByRole("button", { name: new RegExp(`^${slug}\\b`) });
	}

	/** Top-level view navigation. These are buttons, not links — there is no router lib. */
	nav(view: "Metrics" | "Skills" | "Settings"): Locator {
		return this.root.getByRole("button", { name: view });
	}
}

/** The "Clone repository" modal, reachable from the empty state or the sidebar `+`. */
export class CloneRepoDialog {
	readonly root: Locator;

	constructor(page: Page) {
		this.root = page.getByRole("dialog", { name: "Clone repository" });
	}

	get gitUrl(): Locator {
		return this.root.getByLabel("Git URL");
	}

	/** The label reads `Slug (optional, defaults to repo name)`, hence the prefix match. */
	get slug(): Locator {
		return this.root.getByLabel(/^Slug/);
	}

	get submit(): Locator {
		return this.root.getByRole("button", { name: /^Clon/ }); // "Clone" / "Cloning…"
	}

	/** Rendered by the dialog primitive as an icon plus an `sr-only` "Close". */
	get close(): Locator {
		return this.root.getByRole("button", { name: "Close" });
	}

	async expectOpen(): Promise<void> {
		await expect(this.root).toBeVisible();
	}

	async expectClosed(): Promise<void> {
		await expect(this.root).toBeHidden();
	}

	/** Fill and submit in one step — the common path for setting up state. */
	async cloneFrom(url: string, slug?: string): Promise<void> {
		await this.gitUrl.fill(url);
		if (slug) await this.slug.fill(slug);
		await this.submit.click();
	}
}

/** Root page object: the app shell, its landmarks, and navigation. */
export class AppPage {
	readonly sidebar: SidebarObject;
	readonly cloneDialog: CloneRepoDialog;

	constructor(readonly page: Page) {
		this.sidebar = new SidebarObject(page);
		this.cloneDialog = new CloneRepoDialog(page);
	}

	async goto(path = "/"): Promise<void> {
		await this.page.goto(path);
		// The shell is client-rendered; waiting on a landmark rather than a
		// network event keeps this honest about what the user can actually see.
		await expect(this.main).toBeVisible();
	}

	get main(): Locator {
		return this.page.getByRole("main");
	}

	/**
	 * The empty-state `<h1>`. Note there are three literal "dilna" strings on
	 * this screen (header span, sidebar brand, this heading) — the role+level
	 * query is what disambiguates, so don't loosen it to `getByText`.
	 */
	get emptyStateHeading(): Locator {
		return this.page.getByRole("heading", { level: 1, name: "dilna" });
	}

	get cloneRepoCta(): Locator {
		return this.page.getByRole("button", { name: "Clone a repository" });
	}

	/** The `<h1>` of a standalone view, used to assert which screen is showing. */
	heading(name: string): Locator {
		return this.page.getByRole("heading", { level: 1, name });
	}

	async openCloneDialog(): Promise<CloneRepoDialog> {
		await this.cloneRepoCta.click();
		await this.cloneDialog.expectOpen();
		return this.cloneDialog;
	}

	/** Navigate by clicking, so the test exercises the same path a user takes. */
	async navigateTo(view: "Metrics" | "Skills" | "Settings"): Promise<void> {
		await this.sidebar.nav(view).click();
		await expect(this.heading(view)).toBeVisible();
	}
}
