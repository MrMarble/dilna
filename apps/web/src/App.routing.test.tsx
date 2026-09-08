import type { SessionListEvent, SessionView } from "@dilna/shared";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * End-to-end routing behaviour, against the real `App` (not a harness):
 * the two bugs reported were "the orchestrator chat doesn't update the URL"
 * and "Metrics/Settings render as an overlay that traps the sidebar". Both
 * are about how App composes routing with its data layer, so they can only be
 * pinned down here — `useRoute`'s own tests cover the history mechanics, but
 * not App's wiring of it.
 *
 * Only the API client is faked; every component (Sidebar, ChatShell,
 * MetricsPage, SettingsPage) is the real one.
 */

const REPO = {
	id: "repo-1",
	slug: "dilna",
	path: "/tmp/dilna",
	defaultBranch: "main",
	remoteUrl: "git@github.com:owner/dilna.git",
	createdAt: 1,
};

function makeSession(over: Partial<SessionView> = {}): SessionView {
	return {
		id: "sess-1",
		repoId: REPO.id,
		title: "Repo session",
		agentType: "pi",
		kind: "session",
		status: "idle",
		usage: { inputTokens: 0, outputTokens: 0 },
		createdAt: 1,
		lastActiveAt: 1,
		...over,
	};
}

const REPO_SESSION = makeSession();
const ORCHESTRATOR_SESSION = makeSession({
	id: "orc-1",
	title: "Orchestrator chat",
	kind: "orchestrator",
});

const state = vi.hoisted(() => ({
	// Sessions pushed through the cross-session SSE stream on connect.
	sessions: [] as SessionView[],
	createdOrchestrator: null as SessionView | null,
}));

vi.mock("@/api/client", () => ({
	api: {
		repos: {
			list: async () => ({ repos: [REPO] }),
			stats: async () => ({
				stats: { languages: [], fileCount: 0, totalBytes: 0 },
			}),
			sync: async () => ({ status: { ahead: 0, behind: 0 } }),
			pull: async () => ({}),
		},
		sessions: {
			create: async () => ({ session: REPO_SESSION }),
			createOrchestrator: async () => ({
				session: state.createdOrchestrator ?? ORCHESTRATOR_SESSION,
			}),
			delete: async () => ({}),
			get: async () => ({ session: REPO_SESSION, messages: [] }),
			messages: async () => ({ messages: [] }),
			history: async () => ({ messages: [] }),
			// The chat column's live surfaces (ChatShell, UsageBadge,
			// SessionContextRow) all open the per-session SSE stream; a no-op
			// unsubscribe is enough, since none of them is under test here.
			stream: () => () => {},
			send: async () => ({}),
			stop: async () => ({}),
			changedFiles: async () => ({ files: [] }),
			commits: async () => ({ commits: [] }),
			contextUsage: async () => ({
				usage: { usedTokens: 0, maxTokens: 100_000 },
			}),
		},
		sessionList: {
			stream: (onEvent: (ev: SessionListEvent) => void) => {
				for (const session of state.sessions) {
					onEvent({ type: "session_status", session } as SessionListEvent);
				}
				return () => {};
			},
		},
		stream: () => () => {},
		usage: {
			summary: async () => ({
				summary: {
					totals: {
						inputTokens: 0,
						outputTokens: 0,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						reasoningTokens: 0,
						costUsd: 0,
					},
					daily: [],
					dailyByModel: [],
					byRepo: [],
					byModel: [],
				},
			}),
			disk: async () => ({ disk: { totalBytes: 10_000, freeBytes: 4_000 } }),
		},
		config: {
			// `api.config.get` resolves to the LlmConfig itself, not a wrapper.
			get: async () => ({
				override: null,
				envDefault: { provider: "anthropic", model: "claude-opus-4-5" },
				effective: { provider: "anthropic", model: "claude-opus-4-5" },
				apiKeysConfigured: { anthropic: true },
				keyedStoredProviders: [],
				modelsByProvider: {
					anthropic: [{ id: "claude-opus-4-5", name: "Claude Opus 4.5" }],
				},
				oauthConnected: { anthropic: false },
				customProviders: [],
			}),
		},
	},
}));

// Imported after the mock so App picks up the faked client.
const { App } = await import("@/App");

/** happy-dom applies a history entry and fires `popstate` asynchronously, so
 * the resulting React update has to be flushed inside `act` before asserting. */
async function goBack() {
	await act(async () => {
		window.history.back();
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

/** The standalone page's own <h1>, or null when that page isn't rendered. */
function pageHeading(view: "Metrics" | "Settings") {
	return screen.queryByRole("heading", { level: 1, name: view });
}

function sidebar(): HTMLElement {
	// Both the Sidebar and the ContextPanel are <aside>s, and the latter is
	// mounted whenever a session is open — so pick the Sidebar by a control
	// only it has rather than by bare role.
	const collapse = screen.getByTitle("Collapse sidebar");
	const aside = collapse.closest("aside");
	if (!aside) throw new Error("sidebar not mounted");
	return aside;
}

async function renderApp(path: string) {
	window.history.replaceState(null, "", path);
	render(<App />);
	// Wait for the repo list to land, so slug→id resolution has happened.
	// The repo row's branch label is unique to the loaded list (the brand
	// header also says "dilna"), so it's an unambiguous readiness signal.
	await within(sidebar()).findByText("main");
}

beforeEach(() => {
	state.sessions = [REPO_SESSION, ORCHESTRATOR_SESSION];
	state.createdOrchestrator = null;
	window.history.replaceState(null, "", "/");
});

describe("orchestrator chat routing", () => {
	it("updates the URL when an orchestrator chat is opened", async () => {
		const user = userEvent.setup();
		await renderApp("/");

		await user.click(
			within(sidebar()).getByRole("button", { name: /Orchestrator chat/ }),
		);

		// The reported bug: this navigation was purely visual, leaving the URL
		// on whatever it was before.
		expect(window.location.pathname).toBe("/orchestrator/orc-1");
	});

	it("restores an orchestrator chat from a deep link on load", async () => {
		await renderApp("/orchestrator/orc-1");
		// The chat is open, not the empty state.
		await waitFor(() =>
			expect(
				screen.queryByRole("heading", { name: "dilna" }),
			).not.toBeInTheDocument(),
		);
		expect(window.location.pathname).toBe("/orchestrator/orc-1");
	});

	it("goes back from an orchestrator chat to where it came from", async () => {
		const user = userEvent.setup();
		await renderApp("/dilna/sess-1");

		await user.click(
			within(sidebar()).getByRole("button", { name: /Orchestrator chat/ }),
		);
		expect(window.location.pathname).toBe("/orchestrator/orc-1");

		await goBack();
		await waitFor(() => expect(window.location.pathname).toBe("/dilna/sess-1"));
	});
});

describe("Metrics and Settings as real routes", () => {
	for (const view of ["Metrics", "Settings"] as const) {
		const path = `/${view.toLowerCase()}`;

		it(`${view} navigates to ${path}`, async () => {
			const user = userEvent.setup();
			await renderApp("/");
			await user.click(within(sidebar()).getByRole("button", { name: view }));
			expect(window.location.pathname).toBe(path);
			expect(pageHeading(view)).toBeInTheDocument();
		});

		it(`${view} renders from a deep link / refresh`, async () => {
			await renderApp(path);
			expect(window.location.pathname).toBe(path);
			expect(pageHeading(view)).toBeInTheDocument();
		});

		it(`the sidebar still navigates away from ${view}`, async () => {
			const user = userEvent.setup();
			await renderApp("/");
			await user.click(within(sidebar()).getByRole("button", { name: view }));
			expect(window.location.pathname).toBe(path);

			// The reported bug: with the view held in local state, clicking a
			// repo in the sidebar did nothing *visible* at all — the URL moved
			// but the page stayed up, and the only way out was its own back
			// arrow. So assert on what's rendered, not just the URL.
			await user.click(
				within(sidebar()).getByRole("button", { name: /dilna/ }),
			);
			await waitFor(() =>
				expect(window.location.pathname).toBe("/dilna/sess-1"),
			);
			expect(pageHeading(view)).not.toBeInTheDocument();
		});

		it(`browser back leaves ${view}`, async () => {
			const user = userEvent.setup();
			await renderApp("/dilna/sess-1");
			await user.click(within(sidebar()).getByRole("button", { name: view }));
			expect(window.location.pathname).toBe(path);

			await goBack();
			await waitFor(() =>
				expect(window.location.pathname).toBe("/dilna/sess-1"),
			);
			expect(pageHeading(view)).not.toBeInTheDocument();
		});
	}
});

describe("repo/session routing", () => {
	it("normalizes an unknown repo slug back to the root", async () => {
		render(<App />);
		window.history.replaceState(null, "", "/does-not-exist");
		render(<App />);
		await waitFor(() => expect(window.location.pathname).toBe("/"));
	});
});
