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

	/**
	 * A repo row, addressed by the slug the user sees. Clicking it selects the
	 * repo *and* jumps to its latest Session (see App's handleSelectRepo).
	 *
	 * Not anchored at the start: the row also contains the primary-language
	 * icon, whose `img` alt text precedes the slug in the accessible name
	 * (`"TypeScript seeded-repo main"`). After the repo stats request lands
	 * that is true of every repo row, but not before it — which is exactly why
	 * `/^slug/` passed on the empty instance and broke the moment there was a
	 * repo in it. The trailing `\b` keeps `my-repo` from matching `my-repo-2`.
	 */
	repo(slug: string): Locator {
		return this.root.getByRole("button", { name: new RegExp(`\\b${slug}\\b`) });
	}

	/**
	 * A Session row in the selected repo's expanded submenu, addressed by the
	 * Session's title. The submenu only renders for the *selected* repo, so a
	 * caller has to click the repo row first — that's the accordion's real
	 * behaviour, not a test-only step.
	 *
	 * Matched on the exact title: the same string also appears in the chat
	 * header once the Session is open, and the submenu's row is the only
	 * *button* whose accessible name is exactly the title.
	 */
	session(title: string): Locator {
		return this.root.getByRole("button", { name: title, exact: true });
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

/**
 * The right-hand `ContextPanel` (desktop only above the md breakpoint).
 *
 * Addressed as the second `complementary` landmark: the sidebar is the first,
 * and the only stable way to tell them apart is the panel's own collapse
 * control, mirroring how `SidebarObject` pins its root down.
 */
export class ContextPanelObject {
	readonly root: Locator;

	constructor(readonly page: Page) {
		this.root = page.locator("aside").filter({
			has: page.getByRole("button", { name: "Collapse context panel" }),
		});
	}

	/**
	 * A `SectionCard`, addressed by its heading. Returns the enclosing
	 * `<section>` rather than the heading itself, so a caller can read the
	 * card's *content* (`panel.section("Repository").getByText("main")`) — the
	 * heading is a child of the section, sibling to the card body, so chaining
	 * off the heading would only ever search the heading's own text.
	 */
	section(name: string): Locator {
		return this.root
			.locator("section")
			.filter({ has: this.page.getByRole("heading", { level: 3, name }) });
	}

	/** A section's heading, for the common "is this card showing at all"
	 * assertion. */
	sectionHeading(name: string): Locator {
		return this.root.getByRole("heading", { level: 3, name });
	}

	get collapse(): Locator {
		return this.root.getByRole("button", { name: "Collapse context panel" });
	}

	/** Rendered by `ChatHeader` only while the panel is collapsed — collapsing
	 * removes the panel's own reopen affordance along with it. */
	get headerExpand(): Locator {
		return this.page.getByRole("button", { name: "Show context panel" });
	}

	/** A changed-file row, addressed by the path the panel shows (truncated
	 * visually, but the accessible name is the full text). */
	changedFile(filePath: string): Locator {
		return this.root.locator("li").filter({ hasText: filePath });
	}

	/** A commit row, addressed by its subject line. */
	commit(subject: string): Locator {
		return this.root.locator("li").filter({ hasText: subject });
	}
}

/**
 * `ChatHeader` — repo/session breadcrumb and per-Session controls. Only
 * rendered once a repo is selected, so its locators are page-level rather
 * than scoped to a landmark (it has an implicit `banner` role, but the
 * empty-state header shares it).
 */
export class ChatHeaderObject {
	constructor(readonly page: Page) {}

	/** The `Agent · <model>` badge. The model name comes from the instance's
	 * provider config, so only the stable prefix is matched — asserting the
	 * model would pin the suite to whatever env the run happens to have. */
	get agentBadge(): Locator {
		return this.page.getByText(/^Agent · /);
	}

	get deleteSession(): Locator {
		return this.page.getByRole("button", { name: "Delete session" });
	}

	get copyTranscriptLink(): Locator {
		return this.page.getByRole("button", { name: /transcript/i });
	}
}

/** The chat composer at the bottom of `ChatShell`. */
export class ComposerObject {
	constructor(readonly page: Page) {}

	/**
	 * The composer `<textarea>` has no accessible name (it relies on a
	 * placeholder, which drifts with the Session's model), so this matches the
	 * stable `Message ` prefix of that placeholder. That is deliberate rather
	 * than a `nth`/CSS shortcut: the placeholder prefix is part of the copy
	 * contract even though the rest of it isn't.
	 */
	get input(): Locator {
		return this.page.getByPlaceholder(/^Message /);
	}

	get send(): Locator {
		return this.page.getByRole("button", { name: /^(Send|Queue message)$/ });
	}

	get attachFiles(): Locator {
		return this.page.getByRole("button", { name: "Attach files" });
	}

	async expectReady(): Promise<void> {
		await expect(this.input).toBeVisible();
	}
}

/** Root page object: the app shell, its landmarks, and navigation. */
export class AppPage {
	readonly sidebar: SidebarObject;
	readonly cloneDialog: CloneRepoDialog;
	readonly contextPanel: ContextPanelObject;
	readonly chatHeader: ChatHeaderObject;
	readonly composer: ComposerObject;

	constructor(readonly page: Page) {
		this.sidebar = new SidebarObject(page);
		this.cloneDialog = new CloneRepoDialog(page);
		this.contextPanel = new ContextPanelObject(page);
		this.chatHeader = new ChatHeaderObject(page);
		this.composer = new ComposerObject(page);
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

	/**
	 * Navigate straight to a repo-bound Session's canonical URL
	 * (`/<slug>/<session-id>`). Deep-linking is the honest way to reach loaded
	 * state: it exercises `parseRoute` and the repo/session resolution in
	 * `App` rather than depending on click order to get there.
	 */
	async gotoSession(repoSlug: string, sessionId: string): Promise<void> {
		await this.goto(`/${repoSlug}/${sessionId}`);
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
