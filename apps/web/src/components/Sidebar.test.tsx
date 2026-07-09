import type { RateLimitWindow, Repo, SessionView } from "@dilna/shared";
import { render, screen } from "@testing-library/react";
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
		agentType: "claude",
		status: "working",
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
			backgroundSessions={[]}
			repoSlugById={{}}
			onSelectBackgroundSession={noop}
			rateLimitWindows={[]}
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

	it("shows the Repositories and Background Agents section headers", () => {
		renderSidebar({ selectedRepoId: "repo-1" });
		expect(screen.getByText("Repositories")).toBeInTheDocument();
		expect(screen.getByText("Background Agents")).toBeInTheDocument();
	});

	it("renders empty states when repos and background sessions are missing", () => {
		renderSidebar({ selectedRepoId: "repo-1" });
		expect(screen.getByText(/No repos/i)).toBeInTheDocument();
		expect(screen.getByText(/No other sessions running/i)).toBeInTheDocument();
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

	it("highlights the selected repo row", () => {
		const repo = makeRepo({ slug: "alpha" });
		const other = makeRepo({ id: "repo-2", slug: "beta" });
		renderSidebar({ repos: [repo, other], selectedRepoId: repo.id });
		const alphaBtn = screen.getByText("alpha").closest("button");
		const betaBtn = screen.getByText("beta").closest("button");
		const selectedClass = /(?:^|\s)bg-zinc-200(?:\s|$)/;
		expect(alphaBtn?.className).toMatch(selectedClass);
		expect(betaBtn?.className).not.toMatch(selectedClass);
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

	describe("rate-limit footer", () => {
		it("renders nothing when no rate-limit data is available", () => {
			renderSidebar({ rateLimitWindows: [] });
			expect(screen.queryByText("5-hour")).not.toBeInTheDocument();
			expect(screen.queryByText("Weekly")).not.toBeInTheDocument();
		});

		it("renders a bar per fresh window, labeled 5-hour / Weekly", () => {
			renderSidebar({
				rateLimitWindows: [
					makeRateLimitWindow({ kind: "five_hour", utilizationPct: 20 }),
					makeRateLimitWindow({ kind: "seven_day", utilizationPct: 60 }),
				],
			});
			expect(screen.getByText("5-hour")).toBeInTheDocument();
			expect(screen.getByText("Weekly")).toBeInTheDocument();
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
			expect(screen.queryByText("5-hour")).not.toBeInTheDocument();
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
			const label = screen.getByText("5-hour");
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
});
