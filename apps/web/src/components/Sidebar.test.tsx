import type { Repo, SessionView } from "@dilna/shared";
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
		agentType: "opencode",
		status: "working",
		createdAt: 1,
		lastActiveAt: 1,
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
			backgroundSessions={[]}
			repoSlugById={{}}
			onSelectBackgroundSession={noop}
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
});
