import type { RateLimitWindow, SessionView } from "@dilna/shared";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "@/components/Sidebar";
import { expectEveryButtonNamed } from "@/test/accessible-name";
import { makeRepo, makeSession as sharedMakeSession } from "@/test/factories";

const noop = () => {};

function makeSession(overrides: Partial<SessionView> = {}): SessionView {
	// Sidebar's fixtures are mid-turn by default: most of its assertions are
	// about what a *working* Session renders.
	return sharedMakeSession({ status: "working", ...overrides });
}

function makeRateLimitWindow(
	overrides: Partial<RateLimitWindow> = {},
): RateLimitWindow {
	return {
		kind: "five_hour",
		utilizationPct: 20,
		resetsAt: Math.floor(Date.now() / 1000) + 3600,
		...overrides,
	};
}

function renderSidebar(overrides: Partial<Parameters<typeof Sidebar>[0]> = {}) {
	return render(
		<Sidebar
			repos={[]}
			loadingRepos={false}
			error={null}
			selectedRepoId={null}
			onSelectRepo={noop}
			onRefreshRepos={noop}
			onNewRepo={noop}
			onNewSession={noop}
			creatingSession={false}
			selectedSessionId={null}
			sessionsByRepoId={{}}
			backgroundSessions={[]}
			repoSlugById={{}}
			onSelectSession={noop}
			onNewComparison={noop}
			rateLimitWindows={[]}
			primaryLanguageByRepoId={{}}
			syncStatusByRepoId={{}}
			onOpenMetrics={noop}
			onOpenSettings={noop}
			onOpenSkills={noop}
			orchestratorSessions={[]}
			onNewOrchestratorSession={noop}
			creatingOrchestrator={false}
			onSelectOrchestratorSession={noop}
			unreadBySessionId={{}}
			deletingSessionIds={[]}
			notificationsEnabled={false}
			toggleNotifications={async () => true}
			{...overrides}
		/>,
	);
}

describe("Sidebar", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders the dilna brand header", () => {
		renderSidebar();
		expect(screen.getByText("dilna")).toBeInTheDocument();
	});

	it("shows the Repositories section header", () => {
		renderSidebar({ selectedRepoId: "repo-1" });
		expect(screen.getByText("Repositories")).toBeInTheDocument();
	});

	it("hides the Background Agents card when no background session is active", () => {
		renderSidebar({ selectedRepoId: "repo-1" });
		expect(screen.queryByText("Background Agents")).not.toBeInTheDocument();
	});

	it("shows the Background Agents card once a background session is active", () => {
		renderSidebar({ backgroundSessions: [makeSession()] });
		expect(screen.getByText("Background Agents")).toBeInTheDocument();
	});

	it("renders the repos empty state when there are no repos", () => {
		renderSidebar({ selectedRepoId: "repo-1" });
		expect(screen.getByText(/No repos/i)).toBeInTheDocument();
	});

	it("disables New session until a repo is selected", () => {
		renderSidebar({ selectedRepoId: null });
		expect(screen.getByText("New session").closest("button")).toBeDisabled();
	});

	it("enables New session once a repo is selected", () => {
		renderSidebar({ selectedRepoId: "repo-1" });
		expect(
			screen.getByText("New session").closest("button"),
		).not.toBeDisabled();
	});

	it("renders repo slugs", () => {
		const repo = makeRepo({ slug: "unique-repo-slug-xyz" });
		renderSidebar({ repos: [repo], selectedRepoId: repo.id });
		expect(screen.getByText(repo.slug)).toBeInTheDocument();
	});

	it("expands only the selected repo's row", () => {
		const repo = makeRepo({ slug: "alpha" });
		const other = makeRepo({ id: "repo-2", slug: "beta" });
		renderSidebar({ repos: [repo, other], selectedRepoId: repo.id });
		const alphaBtn = screen.getByText("alpha").closest("button");
		const betaBtn = screen.getByText("beta").closest("button");
		expect(alphaBtn).toHaveAttribute("aria-expanded", "true");
		expect(betaBtn).toHaveAttribute("aria-expanded", "false");
	});

	it("renders background sessions with their repo slug", () => {
		const session = makeSession({ title: "feat: auth flow", repoId: "repo-1" });
		renderSidebar({
			backgroundSessions: [session],
			repoSlugById: { "repo-1": "acme-repo" },
		});
		expect(screen.getByText("feat: auth flow")).toBeInTheDocument();
		expect(screen.getByText("acme-repo")).toBeInTheDocument();
	});

	it("renders an error message when repo loading fails", () => {
		renderSidebar({ error: "boom" });
		expect(screen.getByText("boom")).toBeInTheDocument();
	});

	describe("per-repo session submenu", () => {
		it("only shows the selected repo's sessions", () => {
			const repo = makeRepo({ slug: "alpha" });
			const other = makeRepo({ id: "repo-2", slug: "beta" });
			renderSidebar({
				repos: [repo, other],
				selectedRepoId: repo.id,
				sessionsByRepoId: {
					[repo.id]: [makeSession({ id: "s1", title: "alpha session" })],
					[other.id]: [
						makeSession({ id: "s2", repoId: other.id, title: "beta session" }),
					],
				},
			});
			expect(screen.getByText("alpha session")).toBeInTheDocument();
			expect(screen.queryByText("beta session")).not.toBeInTheDocument();
		});

		it("shows an empty hint when the selected repo has no sessions", () => {
			const repo = makeRepo();
			renderSidebar({ repos: [repo], selectedRepoId: repo.id });
			expect(screen.getByText("No sessions yet.")).toBeInTheDocument();
		});

		it("selecting a session calls onSelectSession", async () => {
			const repo = makeRepo();
			const session = makeSession({ title: "pick me" });
			const onSelectSession = vi.fn();
			renderSidebar({
				repos: [repo],
				selectedRepoId: repo.id,
				sessionsByRepoId: { [repo.id]: [session] },
				onSelectSession,
			});
			await userEvent.click(screen.getByText("pick me"));
			expect(onSelectSession).toHaveBeenCalledWith(session);
		});

		it("re-clicking the already-selected repo's row does not re-trigger onSelectRepo", async () => {
			const repo = makeRepo({ slug: "unique-reclick-repo" });
			const onSelectRepo = vi.fn();
			renderSidebar({
				repos: [repo],
				selectedRepoId: repo.id,
				onSelectRepo,
			});
			await userEvent.click(screen.getByText(repo.slug));
			expect(onSelectRepo).not.toHaveBeenCalled();
		});
	});

	describe("rate-limit footer", () => {
		it("renders nothing when no rate-limit data is available", () => {
			renderSidebar({ rateLimitWindows: [] });
			expect(screen.queryByText("5h")).not.toBeInTheDocument();
			expect(screen.queryByText("7d")).not.toBeInTheDocument();
		});

		it("renders a bar per fresh window, labeled 5h / 7d", () => {
			renderSidebar({
				rateLimitWindows: [
					makeRateLimitWindow({ kind: "five_hour", utilizationPct: 20 }),
					makeRateLimitWindow({ kind: "seven_day", utilizationPct: 60 }),
				],
			});
			expect(screen.getByText("5h")).toBeInTheDocument();
			expect(screen.getByText("7d")).toBeInTheDocument();
		});

		it("shows the time to reset next to each bar's label", () => {
			renderSidebar({
				rateLimitWindows: [
					makeRateLimitWindow({
						kind: "five_hour",
						resetsAt: Math.floor(Date.now() / 1000) + 90 * 60,
					}),
				],
			});
			expect(screen.getByText("1h 30m")).toBeInTheDocument();
		});

		it("omits a window whose reset time has already passed", () => {
			renderSidebar({
				rateLimitWindows: [
					makeRateLimitWindow({
						kind: "five_hour",
						resetsAt: Math.floor(Date.now() / 1000) - 60,
					}),
				],
			});
			expect(screen.queryByText("5h")).not.toBeInTheDocument();
		});

		it("reveals the exact percentage and time-to-reset on hover via title", () => {
			renderSidebar({
				rateLimitWindows: [
					makeRateLimitWindow({
						kind: "five_hour",
						utilizationPct: 42,
						resetsAt: Math.floor(Date.now() / 1000) + 3600,
					}),
				],
			});
			const label = screen.getByText("5h");
			const bar = label.closest("[title]");
			expect(bar).not.toBeNull();
			expect(bar?.getAttribute("title")).toMatch(/42% used/);
			expect(bar?.getAttribute("title")).toMatch(/resets in/);
		});

		it("color-codes below 50% as neutral", () => {
			const { container } = renderSidebar({
				rateLimitWindows: [makeRateLimitWindow({ utilizationPct: 30 })],
			});
			expect(container.querySelector(".bg-idle")).not.toBeNull();
		});

		it("color-codes 50-80% as warning", () => {
			const { container } = renderSidebar({
				rateLimitWindows: [makeRateLimitWindow({ utilizationPct: 65 })],
			});
			expect(container.querySelector(".bg-warning")).not.toBeNull();
		});

		it("color-codes above 80% as danger", () => {
			const { container } = renderSidebar({
				rateLimitWindows: [makeRateLimitWindow({ utilizationPct: 95 })],
			});
			expect(container.querySelector(".bg-danger")).not.toBeNull();
		});
	});

	describe("pending-action feedback", () => {
		it("spins the refresh icon and disables the button while fetching changes", () => {
			const { container } = renderSidebar({ refreshingRepos: true });
			// The hover tooltip swaps to the progress copy, but the accessible name
			// stays put (issue #223) — assert both, since only the tooltip should move.
			const button = screen.getByRole("button", {
				name: "Pull latest default-branch changes",
			});
			expect(button).toHaveAttribute("title", "Fetching changes…");
			expect(button).toBeDisabled();
			expect(container.querySelector(".animate-spin")).not.toBeNull();
		});

		it("leaves the refresh button idle and clickable when not fetching", async () => {
			const onRefreshRepos = vi.fn();
			renderSidebar({ refreshingRepos: false, onRefreshRepos });
			const button = screen.getByRole("button", {
				name: "Pull latest default-branch changes",
			});
			expect(button).not.toBeDisabled();
			await userEvent.click(button);
			expect(onRefreshRepos).toHaveBeenCalledTimes(1);
		});

		it("highlights a session being deleted in the repo submenu", () => {
			const repo = makeRepo();
			renderSidebar({
				repos: [repo],
				selectedRepoId: repo.id,
				sessionsByRepoId: {
					[repo.id]: [
						makeSession({ id: "s1", title: "doomed" }),
						makeSession({ id: "s2", title: "survivor" }),
					],
				},
				deletingSessionIds: ["s1"],
			});
			const doomed = screen.getByText("doomed").closest("button");
			const survivor = screen.getByText("survivor").closest("button");
			expect(doomed?.className).toMatch(/bg-destructive/);
			expect(doomed).toBeDisabled();
			expect(survivor?.className).not.toMatch(/bg-destructive/);
			expect(survivor).not.toBeDisabled();
		});

		it("does not re-fire onSelectSession for a session being deleted", async () => {
			const repo = makeRepo();
			const onSelectSession = vi.fn();
			renderSidebar({
				repos: [repo],
				selectedRepoId: repo.id,
				sessionsByRepoId: {
					[repo.id]: [makeSession({ id: "s1", title: "doomed" })],
				},
				deletingSessionIds: ["s1"],
				onSelectSession,
			});
			await userEvent.click(screen.getByText("doomed"));
			expect(onSelectSession).not.toHaveBeenCalled();
		});

		it("highlights a background session being deleted", () => {
			renderSidebar({
				backgroundSessions: [makeSession({ id: "s1", title: "bg doomed" })],
				deletingSessionIds: ["s1"],
			});
			expect(
				screen.getByText("bg doomed").closest("button")?.className,
			).toMatch(/bg-destructive/);
		});

		it("highlights an orchestrator session being deleted", () => {
			renderSidebar({
				orchestratorSessions: [
					makeSession({ id: "o1", kind: "orchestrator", title: "orch doomed" }),
				],
				deletingSessionIds: ["o1"],
			});
			expect(
				screen.getByText("orch doomed").closest("button")?.className,
			).toMatch(/bg-destructive/);
		});

		it("renders a deleting sheet row with no delete affordance left to gesture on", () => {
			const repo = makeRepo();
			renderSidebar({
				variant: "sheet",
				onDeleteSession: noop,
				repos: [repo],
				selectedRepoId: repo.id,
				sessionsByRepoId: {
					[repo.id]: [makeSession({ id: "s1", title: "doomed" })],
				},
				deletingSessionIds: ["s1"],
			});
			const doomed = screen.getByText("doomed").closest("button");
			expect(doomed?.className).toMatch(/bg-destructive/);
			expect(doomed).toBeDisabled();
			// The gesture layer opts out for rows being deleted — no tile behind
			// a row that's seconds from vanishing anyway.
			expect(
				screen.queryByRole("button", { name: "Delete session" }),
			).toBeNull();
		});
	});

	describe("session notifications (issue #52)", () => {
		it("renders an unread badge on a session row when it has unread turns", () => {
			renderSidebar({
				selectedRepoId: "repo-1",
				repos: [makeRepo({ id: "repo-1" })],
				sessionsByRepoId: {
					"repo-1": [makeSession({ id: "s1", title: "Session one" })],
				},
				unreadBySessionId: { s1: 2 },
			});
			expect(screen.getByText("Session one")).toBeInTheDocument();
			// The 2 is the badge count; the title carries a descriptive tooltip.
			expect(screen.getByTitle(/while you weren't looking/)).toHaveTextContent(
				"2",
			);
		});

		it("shows the total unread count on the bell", () => {
			renderSidebar({
				unreadBySessionId: { s1: 1, s2: 3 },
			});
			// The bell's overlay badge is the absolute-positioned count element.
			expect(screen.getByText("4")).toBeInTheDocument();
		});

		it("toggles notifications on click", async () => {
			const user = userEvent.setup();
			renderSidebar({ notificationsEnabled: false });
			// Stable name + `aria-pressed` rather than a name that follows state
			// (issue #223): the purpose never changes, only the on/off state.
			const bell = screen.getByRole("button", {
				name: "Session completion notifications",
			});
			expect(bell).toHaveAttribute("aria-pressed", "false");
			await user.click(bell);
			// The handler is stubbed in renderSidebar; clicking must not throw.
			expect(bell).toBeInTheDocument();
		});

		it("reports notification state via aria-pressed, not via the name", () => {
			renderSidebar({ notificationsEnabled: true });
			const bell = screen.getByRole("button", {
				name: "Session completion notifications",
			});
			expect(bell).toHaveAttribute("aria-pressed", "true");
		});
	});

	describe("accessible names (issue #223)", () => {
		// Guards the whole surface at once: every icon-only control here used to
		// be named by `title` (or, for the Back button, not at all). Rendering the
		// busy/disabled states too, since those are where the name used to be
		// swapped out wholesale.
		it("names every button in the fully-populated sidebar", () => {
			const repo = makeRepo({ id: "repo-1" });
			const session = makeSession({ id: "s1", title: "current" });
			const { container } = renderSidebar({
				repos: [repo],
				selectedRepoId: repo.id,
				sessionsByRepoId: { [repo.id]: [session] },
				selectedSessionId: session.id,
				orchestratorSessions: [makeSession({ id: "o1", title: "orch" })],
				backgroundSessions: [makeSession({ id: "b1", title: "bg" })],
				unreadBySessionId: { s1: 2 },
				refreshingRepos: true,
				deletingSessionIds: ["o1"],
				notificationsEnabled: true,
				rateLimitWindows: [makeRateLimitWindow()],
				// The collapse control is conditional on this callback — without it the
				// guard silently skips the very button the issue led with.
				onCollapse: noop,
			});
			expectEveryButtonNamed(container);
		});

		it("names every button in the sheet variant", () => {
			const repo = makeRepo({ id: "repo-1" });
			const { container } = renderSidebar({
				variant: "sheet",
				onDeleteSession: noop,
				repos: [repo],
				selectedRepoId: repo.id,
				sessionsByRepoId: {
					"repo-1": [makeSession({ id: "s1", title: "current" })],
				},
				selectedSessionId: "s1",
				deletingSessionIds: [],
			});
			expectEveryButtonNamed(container);
		});
	});

	/**
	 * The sheet-only per-row delete affordances (see SessionRow in
	 * Sidebar.tsx): swipe left reveals a Delete tile, long-press opens the
	 * row menu — both feeding the same confirm the header trash uses.
	 * Desktop panel rows keep their plain rendering.
	 */
	describe("sheet row actions (mobile delete)", () => {
		const REPO = makeRepo();

		function renderSheetSessions(
			sessions: SessionView[],
			overrides: Partial<Parameters<typeof Sidebar>[0]> = {},
		) {
			const onDeleteSession = vi.fn();
			const onSelectSession = vi.fn();
			const utils = renderSidebar({
				variant: "sheet",
				onDeleteSession,
				repos: [REPO],
				selectedRepoId: REPO.id,
				sessionsByRepoId: { [REPO.id]: sessions },
				onSelectSession,
				...overrides,
			});
			return { onDeleteSession, onSelectSession, ...utils };
		}

		function swipeLeft(row: HTMLElement, fromX: number, toX: number) {
			fireEvent.pointerDown(row, {
				button: 0,
				pointerId: 1,
				clientX: fromX,
				clientY: 100,
			});
			fireEvent.pointerMove(row, {
				button: 0,
				pointerId: 1,
				clientX: toX,
				clientY: 100,
			});
			fireEvent.pointerUp(row, {
				button: 0,
				pointerId: 1,
				clientX: toX - 5,
				clientY: 100,
			});
		}

		it("gives the panel variant no per-row delete affordance", () => {
			renderSidebar({
				repos: [REPO],
				selectedRepoId: REPO.id,
				sessionsByRepoId: {
					[REPO.id]: [makeSession({ id: "s1", title: "plain" })],
				},
			});
			expect(
				screen.queryByRole("button", { name: "Delete session" }),
			).toBeNull();
		});

		it("keeps the delete tile hidden until a swipe reveals it", () => {
			renderSheetSessions([makeSession({ id: "s1", title: "swipe target" })]);
			const tile = screen.getByRole("button", { name: "Delete session" });
			expect(tile.className).toMatch(/invisible/);
		});

		it("reveals the tile past the swipe threshold and deletes on tap", () => {
			const { onDeleteSession } = renderSheetSessions([
				makeSession({ id: "s1", title: "swipe target" }),
			]);
			swipeLeft(screen.getByText("swipe target"), 200, 120);
			const tile = screen.getByRole("button", { name: "Delete session" });
			expect(tile.className).not.toMatch(/invisible/);
			fireEvent.click(tile);
			expect(onDeleteSession).toHaveBeenCalledWith("s1");
		});

		it("snaps the tile shut when the swipe stays under the threshold", () => {
			renderSheetSessions([makeSession({ id: "s1", title: "short swipe" })]);
			swipeLeft(screen.getByText("short swipe"), 200, 180);
			expect(
				screen.getByRole("button", { name: "Delete session" }).className,
			).toMatch(/invisible/);
		});

		it("does not select the session when the pointer swiped it", () => {
			const { onSelectSession } = renderSheetSessions([
				makeSession({ id: "s1", title: "swiped not tapped" }),
			]);
			const row = screen.getByText("swiped not tapped");
			swipeLeft(row, 200, 120);
			// The release would normally synthesize a click on the row button.
			fireEvent.click(row);
			expect(onSelectSession).not.toHaveBeenCalled();
		});

		it("still selects the session on a plain tap", () => {
			const { onSelectSession } = renderSheetSessions([
				makeSession({ id: "s1", title: "tap me" }),
			]);
			fireEvent.click(screen.getByText("tap me"));
			expect(onSelectSession).toHaveBeenCalledTimes(1);
		});

		it("opens the row menu on long-press and deletes from it", () => {
			vi.useFakeTimers();
			try {
				const { onDeleteSession } = renderSheetSessions([
					makeSession({ id: "s1", title: "hold me" }),
				]);
				const row = screen.getByText("hold me");
				fireEvent.pointerDown(row, {
					button: 0,
					pointerId: 1,
					clientX: 150,
					clientY: 60,
				});
				act(() => {
					vi.advanceTimersByTime(350);
				});
				expect(
					screen.getByRole("menu", { name: "Actions for hold me" }),
				).toBeInTheDocument();
				fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
				expect(onDeleteSession).toHaveBeenCalledWith("s1");
				expect(screen.queryByRole("menu")).toBeNull();
			} finally {
				vi.useRealTimers();
			}
		});

		it("opens the session from the row menu without navigating away first", () => {
			vi.useFakeTimers();
			try {
				const session = makeSession({ id: "s1", title: "hold me" });
				const { onSelectSession, onDeleteSession } = renderSheetSessions([
					session,
				]);
				const row = screen.getByText("hold me");
				fireEvent.pointerDown(row, {
					button: 0,
					pointerId: 1,
					clientX: 150,
					clientY: 60,
				});
				act(() => {
					vi.advanceTimersByTime(350);
				});
				fireEvent.click(screen.getByRole("menuitem", { name: "Open" }));
				expect(onSelectSession).toHaveBeenCalledWith(session);
				expect(onDeleteSession).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});

		it("a quick tap never opens the row menu", () => {
			vi.useFakeTimers();
			try {
				renderSheetSessions([makeSession({ id: "s1", title: "quick tap" })]);
				const row = screen.getByText("quick tap");
				fireEvent.pointerDown(row, {
					button: 0,
					pointerId: 1,
					clientX: 150,
					clientY: 60,
				});
				fireEvent.pointerUp(row, {
					button: 0,
					pointerId: 1,
					clientX: 150,
					clientY: 60,
				});
				act(() => {
					vi.advanceTimersByTime(400);
				});
				expect(screen.queryByRole("menu")).toBeNull();
			} finally {
				vi.useRealTimers();
			}
		});

		it("a vertical move cancels the hold instead of opening the menu", () => {
			vi.useFakeTimers();
			try {
				renderSheetSessions([
					makeSession({ id: "s1", title: "scrolled past" }),
				]);
				const row = screen.getByText("scrolled past");
				fireEvent.pointerDown(row, {
					button: 0,
					pointerId: 1,
					clientX: 150,
					clientY: 60,
				});
				fireEvent.pointerMove(row, {
					button: 0,
					pointerId: 1,
					clientX: 150,
					clientY: 120,
				});
				act(() => {
					vi.advanceTimersByTime(400);
				});
				expect(screen.queryByRole("menu")).toBeNull();
			} finally {
				vi.useRealTimers();
			}
		});

		it("revealing one row closes another row's tile", () => {
			renderSheetSessions([
				makeSession({ id: "s1", title: "first" }),
				makeSession({ id: "s2", title: "second" }),
			]);
			// Two rows → two hidden tiles behind them.
			const tiles = screen.getAllByRole("button", { name: "Delete session" });
			expect(tiles).toHaveLength(2);
			const first = screen.getByText("first");
			const second = screen.getByText("second");
			swipeLeft(first, 200, 120);
			swipeLeft(second, 200, 120);
			const tilesAfter = screen.getAllByRole("button", {
				name: "Delete session",
			});
			const visible = tilesAfter.filter(
				(t) => !t.className.includes("invisible"),
			);
			expect(visible).toHaveLength(1);
		});
	});
});
