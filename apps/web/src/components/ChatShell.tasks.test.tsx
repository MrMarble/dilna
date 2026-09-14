import type { AgentStreamEvent, SessionView } from "@dilna/shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import { ChatShell } from "@/components/ChatShell";

/**
 * The "N active tasks" hint (issue #206, ADR-0034): while an Agent has
 * read-only subagents in flight, the composer shows a count so the user knows
 * work is fanned out.
 *
 * Driven entirely by `turn_activity.tasks` — a field ADR-0016 §5 already
 * defined and which gained its first producer in ADR-0034 — so these tests
 * push the same events the server broadcasts.
 */

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
	},
}));

function makeSession(): SessionView {
	return {
		id: "sess-1",
		repoId: "repo-1",
		title: "Test session",
		agentType: "pi",
		kind: "session",
		status: "working",
		usage: { inputTokens: 0, outputTokens: 0 },
		createdAt: 1,
		lastActiveAt: 1,
	};
}

function task(taskId: string, description: string) {
	return {
		taskId,
		description,
		lastTool: "grep",
		toolUses: 2,
		startedAt: Date.now(),
	};
}

function activity(
	tasks: ReturnType<typeof task>[],
): Extract<AgentStreamEvent, { type: "turn_activity" }> {
	return {
		type: "turn_activity",
		phase: null,
		runningTools: [],
		tasks,
		serverTime: Date.now(),
	};
}

let emit: ((ev: AgentStreamEvent) => void) | null = null;

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	emit = null;
	vi.mocked(api.sessions.messages).mockResolvedValue({ messages: [] });
	vi.mocked(api.sessions.queuedMessages).mockResolvedValue({ queued: [] });
	vi.mocked(api.sessions.stream).mockImplementation((_id, onEvent, onOpen) => {
		emit = onEvent;
		onOpen?.();
		return () => {};
	});
});

function renderShell() {
	return render(
		<ChatShell sessionId="sess-1" session={makeSession()} isDesktop={true} />,
	);
}

describe("active task hint", () => {
	it("shows nothing while no subagents are running", async () => {
		renderShell();
		await waitFor(() => expect(emit).toBeTruthy());

		act(() => emit?.(activity([])));

		expect(screen.queryByText(/active task/)).toBeNull();
	});

	it("singularises a single running task", async () => {
		renderShell();
		await waitFor(() => expect(emit).toBeTruthy());

		act(() => emit?.(activity([task("t1", "Find auth call sites")])));

		expect(await screen.findByText("1 active task")).toBeTruthy();
	});

	it("counts several parallel subagents", async () => {
		renderShell();
		await waitFor(() => expect(emit).toBeTruthy());

		act(() =>
			emit?.(
				activity([
					task("t1", "Find auth call sites"),
					task("t2", "Trace the event union"),
					task("t3", "Check migrations"),
				]),
			),
		);

		expect(await screen.findByText("3 active tasks")).toBeTruthy();
	});

	it("clears the hint once the tasks finish", async () => {
		renderShell();
		await waitFor(() => expect(emit).toBeTruthy());

		act(() => emit?.(activity([task("t1", "Find auth call sites")])));
		expect(await screen.findByText("1 active task")).toBeTruthy();

		act(() => emit?.(activity([])));
		await waitFor(() => expect(screen.queryByText(/active task/)).toBeNull());
	});

	it("clears the hint when the turn ends", async () => {
		renderShell();
		await waitFor(() => expect(emit).toBeTruthy());

		act(() => emit?.(activity([task("t1", "Find auth call sites")])));
		expect(await screen.findByText("1 active task")).toBeTruthy();

		// turn_activity is valid only inside a turn (ADR-0016 §5) — a terminal
		// status clears it client-side.
		act(() => emit?.({ type: "session_status", status: "idle" }));
		await waitFor(() => expect(screen.queryByText(/active task/)).toBeNull());
	});
});
