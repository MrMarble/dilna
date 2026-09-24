import type { Message, QueuedMessage, SessionListEvent } from "@dilna/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PartialApi } from "@/test/api-mock";
import { makeRepo, makeSession } from "@/test/factories";

/**
 * The mobile drawer's repo → Session flow, against the real `App`.
 *
 * Reported problem: tapping a repo in the sidebar closed the drawer
 * immediately (App's `handleSelectRepo` opened the repo's most recently
 * active Session and then dismissed the sheet). On a phone that meant the
 * Session list the tap had just expanded was never visible, so anyone with
 * more than one Session per repo had to reopen the drawer and try again.
 *
 * `useIsDesktop` reads `(min-width: 768px)` through base-ui's `useMediaQuery`,
 * and happy-dom reports `matches: true`, so the shared App suites all run as
 * desktop and never mount the sheet. This file stubs `matchMedia` to report
 * narrow to reach that path. Only the API client is faked.
 */

const REPO = makeRepo();

// Two Sessions on the one repo, with a clear "most recent" winner: if
// selecting the repo auto-opened anything, it would open `newer`.
const NEWER_SESSION = makeSession({
	id: "sess-newer",
	title: "Newer session",
	lastActiveAt: 200,
});
const OLDER_SESSION = makeSession({
	id: "sess-older",
	title: "Older session",
	lastActiveAt: 100,
});

const USER_MESSAGE: Message = {
	id: "msg-1",
	sessionId: NEWER_SESSION.id,
	turnId: "turn-1",
	role: "user",
	parts: [{ type: "text", text: "hello" }],
	createdAt: 1,
};
const QUEUED_MESSAGE: QueuedMessage = {
	id: "queued-1",
	sessionId: NEWER_SESSION.id,
	text: "hello",
	attachments: [],
	createdAt: 1,
};

vi.mock("@/api/client", () => ({
	api: {
		repos: {
			list: async () => ({ repos: [REPO] }),
			stats: async () => ({
				stats: { languages: [], fileCount: 0, totalBytes: 0 },
			}),
			sync: async () => ({ status: { ahead: 0, behind: 0 } }),
			pull: async (id: string) => ({ repo: { ...REPO, id } }),
		},
		sessions: {
			create: async () => ({ session: NEWER_SESSION, contextUsage: null }),
			createOrchestrator: async () => ({
				session: NEWER_SESSION,
				contextUsage: null,
			}),
			delete: async (id: string) => ({ ok: true, id }),
			get: async () => ({ session: NEWER_SESSION, contextUsage: null }),
			messages: async () => ({ messages: [] }),
			stream: () => () => {},
			send: async () => ({ ok: true, message: USER_MESSAGE }),
			queueMessage: async () => ({ ok: true, entry: QUEUED_MESSAGE }),
			queuedMessages: async () => ({ queued: [] }),
			removeQueuedMessage: async () => ({ ok: true }),
			stop: async (id: string) => ({ ok: true, id }),
			changedFiles: async () => ({ files: [] }),
			commits: async () => ({ commits: [] }),
			artefacts: async () => ({ artefacts: [] }),
			scores: async () => ({ scores: [] }),
		},
		skills: { forRepo: async () => ({ skills: [] }) },
		sessionList: {
			stream: (onEvent: (ev: SessionListEvent) => void) => {
				for (const session of [NEWER_SESSION, OLDER_SESSION]) {
					onEvent({ type: "session_status", session } as SessionListEvent);
				}
				return () => {};
			},
		},
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
					topSessions: [],
					byPurpose: [],
				},
			}),
			disk: async () => ({ disk: { totalBytes: 10_000, freeBytes: 4_000 } }),
		},
		config: {
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
	} satisfies PartialApi,
}));

// Imported after the mock so App picks up the faked client.
const { App } = await import("@/App");

/** Every media query reports "narrow", so `useIsDesktop()` is false and the
 * drawer path is the one under test. */
function stubNarrowViewport() {
	vi.stubGlobal(
		"matchMedia",
		vi.fn().mockReturnValue({
			matches: false,
			media: "(min-width: 768px)",
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
		}),
	);
}

/** The open drawer. Both the desktop aside and the sheet render `<Sidebar>`,
 * but only one is mounted at a time, so the drawer's own dialog role is the
 * unambiguous handle. */
function sheet(): HTMLElement {
	const dialog = screen.queryByRole("dialog");
	if (!dialog) throw new Error("mobile sheet not open");
	return dialog;
}

async function openMenuSheet(user: ReturnType<typeof userEvent.setup>) {
	await user.click(screen.getByRole("button", { name: "Toggle menu" }));
	const drawer = await screen.findByRole("dialog");
	// The repo list arrives asynchronously; its branch label is the readiness
	// signal (the brand header also says "dilna").
	await within(drawer).findByText("main");
}

beforeEach(() => {
	stubNarrowViewport();
	window.history.replaceState(null, "", "/");
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("mobile drawer: selecting a repo", () => {
	it("keeps the drawer open and shows the repo's Sessions", async () => {
		const user = userEvent.setup();
		render(<App />);
		await openMenuSheet(user);

		await user.click(within(sheet()).getByRole("button", { name: /dilna/ }));

		// The regression: the drawer used to close on this tap, hiding the
		// Session list it had just expanded.
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(within(sheet()).getByText("Newer session")).toBeInTheDocument();
		expect(within(sheet()).getByText("Older session")).toBeInTheDocument();
	});

	it("opens no Session — not even the most recently active one", async () => {
		const user = userEvent.setup();
		render(<App />);
		await openMenuSheet(user);

		await user.click(within(sheet()).getByRole("button", { name: /dilna/ }));

		// Selecting the repo routed to the bare repo path, so the chat column
		// shows the repo's empty state rather than `sess-newer`.
		expect(window.location.pathname).toBe("/dilna");
	});

	it("dismisses the drawer only once a Session is picked", async () => {
		const user = userEvent.setup();
		render(<App />);
		await openMenuSheet(user);
		await user.click(within(sheet()).getByRole("button", { name: /dilna/ }));

		await user.click(
			within(sheet()).getByRole("button", { name: /Older session/ }),
		);

		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(window.location.pathname).toBe("/dilna/sess-older");
	});
});
