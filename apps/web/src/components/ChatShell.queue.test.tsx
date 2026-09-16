import type {
	AgentStreamEvent,
	QueuedMessage,
	SessionView,
} from "@dilna/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import { ChatShell } from "@/components/ChatShell";

/**
 * The composer's server-held send queue (ADR-0033): submitting while the
 * agent is busy POSTs to the queue endpoint instead of the send endpoint,
 * the tray renders the server's queue (seeded by GET, kept live by
 * `queue_update` events), and entries are removable until dispatched.
 *
 * Dispatch itself is *server-side* (it must survive a locked phone), so
 * these tests assert the client never dispatches — it only mirrors.
 *
 * The API module is mocked wholesale — this is about the composer's own
 * behaviour, not the network.
 */

// Plain factory (no `importOriginal` spread) — matching the other ChatShell
// tests' convention, the only shape where the `api` override reliably wins
// for every importer.
vi.mock("@/api/client", () => ({
	ApiError: class ApiError extends Error {
		constructor(
			public status: number,
			public body: unknown,
			message: string,
		) {
			super(message);
		}
	},
	attachmentUrl: (sessionId: string, attachmentId: string) =>
		`/api/sessions/${sessionId}/attachments/${attachmentId}`,
	api: {
		sessions: {
			messages: vi.fn(),
			send: vi.fn(),
			queueMessage: vi.fn(),
			queuedMessages: vi.fn(),
			removeQueuedMessage: vi.fn(),
			uploadAttachment: vi.fn(),
			stop: vi.fn(),
			stream: vi.fn(),
			changedFiles: vi.fn(),
			commits: vi.fn(),
			artefacts: vi.fn(),
			get: vi.fn(),
		},
		// The composer reads the Repo's Skills for its slash-command menu.
		skills: {
			forRepo: vi.fn(async () => ({ skills: [] })),
		},
	},
}));

function makeSession(status: SessionView["status"]): SessionView {
	return {
		id: "sess-1",
		repoId: "repo-1",
		title: "Test session",
		agentType: "pi",
		kind: "session",
		status,
		usage: { inputTokens: 0, outputTokens: 0 },
		createdAt: 1,
		lastActiveAt: 1,
	};
}

function makeEntry(id: string, text: string): QueuedMessage {
	return { id, sessionId: "sess-1", text, attachments: [], createdAt: 1 };
}

/** The captured per-session stream handler, so tests can push events the
 * way the server would. */
let emit: ((ev: AgentStreamEvent) => void) | null = null;

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	emit = null;
	vi.mocked(api.sessions.messages).mockResolvedValue({ messages: [] });
	vi.mocked(api.sessions.queuedMessages).mockResolvedValue({ queued: [] });
	vi.mocked(api.sessions.queueMessage).mockImplementation(
		async (_id, text: string) => ({
			ok: true,
			entry: makeEntry(`q-${text}`, text),
		}),
	);
	vi.mocked(api.sessions.removeQueuedMessage).mockResolvedValue({ ok: true });
	// History (and now the queue snapshot) are fetched by the on-open resync
	// routine (ADR-0016 §4), so the fake stream must fire `onOpen`; the
	// handler is captured for the tests to emit server events through.
	vi.mocked(api.sessions.stream).mockImplementation((_id, onEvent, onOpen) => {
		emit = onEvent;
		onOpen?.();
		return () => {};
	});
});

function renderShell(status: SessionView["status"] = "working") {
	return render(
		<ChatShell
			sessionId="sess-1"
			session={makeSession(status)}
			isDesktop={true}
		/>,
	);
}

async function submitMessage(text: string) {
	const textarea = screen.getByRole("textbox");
	await userEvent.type(textarea, text);
	await userEvent.keyboard("{Enter}");
}

describe("queueing while the agent is busy", () => {
	it("keeps the input enabled and enqueues via the queue endpoint", async () => {
		renderShell("working");

		const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
		expect(textarea.disabled).toBe(false);

		await submitMessage("next task");

		// Queued server-side, not sent: the queue POST carries the text, the
		// send endpoint is never touched, the composer clears, and the tray
		// shows the accepted entry.
		await waitFor(() => {
			expect(api.sessions.queueMessage).toHaveBeenCalledWith(
				"sess-1",
				"next task",
				[],
			);
		});
		expect(api.sessions.send).not.toHaveBeenCalled();
		expect(await screen.findByText("next task")).toBeTruthy();
		expect(await screen.findByText("queued")).toBeTruthy();
		expect(textarea.value).toBe("");
	});

	it("queues behind existing entries even when the session is idle", async () => {
		// Entries already queued (e.g. enqueued from another device) mean a
		// new submission must not jump the line with a direct send — the
		// server's drain order is the contract.
		vi.mocked(api.sessions.queuedMessages).mockResolvedValue({
			queued: [makeEntry("q-old", "older")],
		});
		renderShell("idle");
		expect(await screen.findByText("older")).toBeTruthy();

		await submitMessage("newer");

		await waitFor(() => {
			expect(api.sessions.queueMessage).toHaveBeenCalledWith(
				"sess-1",
				"newer",
				[],
			);
		});
		expect(api.sessions.send).not.toHaveBeenCalled();
	});

	it("sends directly when idle with an empty queue", async () => {
		vi.mocked(api.sessions.send).mockResolvedValue({
			ok: true,
			message: {
				id: "m1",
				sessionId: "sess-1",
				role: "user",
				parts: [{ type: "text", text: "hello" }],
				turnId: null,
				createdAt: 1,
			},
		});
		renderShell("idle");

		await submitMessage("hello");

		await waitFor(() => {
			expect(api.sessions.send).toHaveBeenCalledWith("sess-1", "hello", []);
		});
		expect(api.sessions.queueMessage).not.toHaveBeenCalled();
	});

	it("keeps the draft when the enqueue fails", async () => {
		vi.mocked(api.sessions.queueMessage).mockRejectedValue(
			new Error("server is shutting down"),
		);
		// A non-empty transcript — the error marker only renders alongside
		// messages, never over the empty-state hint.
		vi.mocked(api.sessions.messages).mockResolvedValue({
			messages: [
				{
					id: "m0",
					sessionId: "sess-1",
					role: "user",
					parts: [{ type: "text", text: "earlier message" }],
					turnId: null,
					createdAt: 1,
				},
			],
		});
		renderShell("working");
		await screen.findByText("earlier message");

		await submitMessage("precious words");

		expect(await screen.findByText(/server is shutting down/)).toBeTruthy();
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
			"precious words",
		);
	});
});

describe("mirroring the server's queue", () => {
	it("renders the queue snapshot fetched on connect", async () => {
		// A page refresh (or a second device) sees whatever the server holds —
		// nothing lives only in a browser anymore.
		vi.mocked(api.sessions.queuedMessages).mockResolvedValue({
			queued: [makeEntry("q1", "restored entry")],
		});
		renderShell("working");

		expect(await screen.findByText("restored entry")).toBeTruthy();
	});

	it("replaces the tray wholesale on queue_update events", async () => {
		renderShell("working");
		await submitMessage("mine");
		await screen.findByText("mine");

		// The server drained the queue into a turn — the level-based event
		// empties every tab's tray at once.
		act(() => emit?.({ type: "queue_update", queued: [] }));
		await waitFor(() => {
			expect(screen.queryByText("mine")).toBeNull();
		});

		// Another tab enqueued — this tray converges on that too.
		act(() =>
			emit?.({
				type: "queue_update",
				queued: [makeEntry("q-other", "from another tab")],
			}),
		);
		expect(await screen.findByText("from another tab")).toBeTruthy();
	});

	it("removes a queued entry through the API", async () => {
		vi.mocked(api.sessions.queuedMessages).mockResolvedValue({
			queued: [makeEntry("q1", "changed my mind")],
		});
		renderShell("working");
		await screen.findByText("changed my mind");

		await userEvent.click(
			screen.getByRole("button", { name: /remove queued message/i }),
		);

		await waitFor(() => {
			expect(api.sessions.removeQueuedMessage).toHaveBeenCalledWith(
				"sess-1",
				"q1",
			);
		});
		expect(screen.queryByText("changed my mind")).toBeNull();
	});
});
