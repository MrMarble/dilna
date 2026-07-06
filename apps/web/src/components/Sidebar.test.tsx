import type { Repo, SessionView } from "@dilna/shared";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "@/components/Sidebar";

const noop = async () => {};

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
		status: "idle",
		createdAt: 1,
		lastActiveAt: 1,
		...overrides,
	};
}

describe("Sidebar", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders the dilna brand header", () => {
		render(
			<Sidebar
				repos={[]}
				sessions={[]}
				loadingRepos={false}
				loadingSessions={false}
				error={null}
				selectedRepoId={null}
				selectedSessionId={null}
				onSelectRepo={noop}
				onSelectSession={noop}
				onRefreshRepos={noop}
				onNewRepo={noop}
				onNewSession={noop}
				onDeleteSession={noop}
			/>,
		);
		expect(screen.getByText("dilna")).toBeInTheDocument();
	});

	it("shows the Repositories and Sessions section headers", () => {
		render(
			<Sidebar
				repos={[]}
				sessions={[]}
				loadingRepos={false}
				loadingSessions={false}
				error={null}
				selectedRepoId="repo-1"
				selectedSessionId={null}
				onSelectRepo={noop}
				onSelectSession={noop}
				onRefreshRepos={noop}
				onNewRepo={noop}
				onNewSession={noop}
				onDeleteSession={noop}
			/>,
		);
		// Both section headers are the only elements with those uppercase
		// strings — the brand is lowercase, so a substring match works.
		expect(screen.getByText("Repositories")).toBeInTheDocument();
		expect(screen.getByText("Sessions")).toBeInTheDocument();
	});

	it("renders empty states when repos and sessions are missing", () => {
		render(
			<Sidebar
				repos={[]}
				sessions={[]}
				loadingRepos={false}
				loadingSessions={false}
				error={null}
				selectedRepoId="repo-1"
				selectedSessionId={null}
				onSelectRepo={noop}
				onSelectSession={noop}
				onRefreshRepos={noop}
				onNewRepo={noop}
				onNewSession={noop}
				onDeleteSession={noop}
			/>,
		);
		expect(screen.getByText(/No repos/i)).toBeInTheDocument();
		expect(screen.getByText(/No sessions/i)).toBeInTheDocument();
	});

	it("renders repo slugs and session titles when present", () => {
		const repo = makeRepo({ slug: "unique-repo-slug-xyz" });
		const session = makeSession({ title: "feat: auth flow" });
		render(
			<Sidebar
				repos={[repo]}
				sessions={[session]}
				loadingRepos={false}
				loadingSessions={false}
				error={null}
				selectedRepoId={repo.id}
				selectedSessionId={session.id}
				onSelectRepo={noop}
				onSelectSession={noop}
				onRefreshRepos={noop}
				onNewRepo={noop}
				onNewSession={noop}
				onDeleteSession={noop}
			/>,
		);
		expect(screen.getByText(repo.slug)).toBeInTheDocument();
		expect(screen.getByText("feat: auth flow")).toBeInTheDocument();
	});

	it("highlights the selected repo and session rows", () => {
		const repo = makeRepo({ slug: "alpha" });
		const other = makeRepo({ id: "repo-2", slug: "beta" });
		const session = makeSession({ title: "session A" });
		render(
			<Sidebar
				repos={[repo, other]}
				sessions={[session]}
				loadingRepos={false}
				loadingSessions={false}
				error={null}
				selectedRepoId={repo.id}
				selectedSessionId={session.id}
				onSelectRepo={noop}
				onSelectSession={noop}
				onRefreshRepos={noop}
				onNewRepo={noop}
				onNewSession={noop}
				onDeleteSession={noop}
			/>,
		);
		const alphaBtn = screen.getByText("alpha").closest("button");
		const betaBtn = screen.getByText("beta").closest("button");
		// Selected class is anchored at the start (no `hover:` prefix).
		const selectedClass = /(?:^|\s)bg-zinc-200(?:\s|$)/;
		expect(alphaBtn?.className).toMatch(selectedClass);
		expect(betaBtn?.className).not.toMatch(selectedClass);

		const sessionRow = screen.getByText("session A").closest("button");
		// The wrapping row <div> carries the selected background.
		expect(sessionRow?.parentElement?.className).toMatch(selectedClass);
	});

	it("omits the Sessions section when no repo is selected", () => {
		render(
			<Sidebar
				repos={[]}
				sessions={[]}
				loadingRepos={false}
				loadingSessions={false}
				error={null}
				selectedRepoId={null}
				selectedSessionId={null}
				onSelectRepo={noop}
				onSelectSession={noop}
				onRefreshRepos={noop}
				onNewRepo={noop}
				onNewSession={noop}
				onDeleteSession={noop}
			/>,
		);
		expect(screen.queryByText("Sessions")).not.toBeInTheDocument();
	});

	it("renders an error message when repo loading fails", () => {
		render(
			<Sidebar
				repos={[]}
				sessions={[]}
				loadingRepos={false}
				loadingSessions={false}
				error="boom"
				selectedRepoId={null}
				selectedSessionId={null}
				onSelectRepo={noop}
				onSelectSession={noop}
				onRefreshRepos={noop}
				onNewRepo={noop}
				onNewSession={noop}
				onDeleteSession={noop}
			/>,
		);
		expect(screen.getByText("boom")).toBeInTheDocument();
	});
});
