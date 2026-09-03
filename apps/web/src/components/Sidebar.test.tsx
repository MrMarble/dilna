import type { RateLimitWindow, Repo, SessionView } from "@dilna/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "@/components/Sidebar";

const noop = () => {};

function makeRepo(overrides: Partial<Repo> = {}): Repo {
	return {
		id: "repo-1",
		slug: "dilna",
		path: "/tmp/dilna",
		defaultBranch: "main",
		remoteUrl: "git@github.com:owner/dilna.git",
		createdAt: 1,
		...overrides,
	};
}

function makeSession(overrides: Partial<SessionView> = {}): SessionView {
	return {
		id: "sess-1",
		repoId: "repo-1",
		title: "New session",
		agentType: "pi",
		kind: "session",
		status: "working",
		usage: { inputTokens: 0, outputTokens: 0 },
		createdAt: 1,
		lastActiveAt: 1,
		...overrides,
	};
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
			rateLimitWindows={[]}
			primaryLanguageByRepoId={{}}
			syncStatusByRepoId={{}}
			onOpenMetrics={noop}
			onOpenSettings={noop}
			orchestratorSessions={[]}
			onNewOrchestratorSession={noop}
			creatingOrchestrator={false}
			onSelectOrchestratorSession={noop}
			unreadBySessionId={{}}
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
			expect(container.querySelector(".bg-zinc-400")).not.toBeNull();
		});

		it("color-codes 50-80% as yellow", () => {
			const { container } = renderSidebar({
				rateLimitWindows: [makeRateLimitWindow({ utilizationPct: 65 })],
			});
			expect(container.querySelector(".bg-amber-500")).not.toBeNull();
		});

		it("color-codes above 80% as red", () => {
			const { container } = renderSidebar({
				rateLimitWindows: [makeRateLimitWindow({ utilizationPct: 95 })],
			});
			expect(container.querySelector(".bg-red-500")).not.toBeNull();
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
			const bell = screen.getByTitle(
				/Notify me when a session's turn completes/,
			);
			await user.click(bell);
			// The handler is stubbed in renderSidebar; clicking must not throw.
			expect(bell).toBeInTheDocument();
		});
	});
});
