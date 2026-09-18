import type { AgentStreamEvent } from "@dilna/shared";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import { ChatShell } from "@/components/ChatShell";
import type { PartialApi } from "@/test/api-mock";
import { makeAttachment, makeSession } from "@/test/factories";

/**
 * The *live* path for an Agent-sent image (issue #222, ADR-0038).
 *
 * `ChatShell.attachments.test.tsx` covers an image already in the persisted
 * history. This covers the one the Agent sends *during* a turn: the
 * `image_sent` event reaches the stream, and the picture has to appear in the
 * live message immediately rather than at `message_end`.
 *
 * That distinction is the whole point. The shared `isMessageContentEvent`
 * guard narrows a `token`/`tool_call_start`/`tool_call_end`/`image_sent` set,
 * and the client's own copy of that narrowing (in `lib/live-messages.ts`) had
 * dropped `image_sent` — so the event was subscribed to, delivered, and then
 * silently discarded by a switch with no case for it. The image only showed
 * up after the turn ended and `message_end` triggered a refetch.
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
		skills: { forRepo: vi.fn(async () => ({ skills: [] })) },
	} satisfies PartialApi,
}));

const session = makeSession({ title: "Test session" });

/** Captures the live-event sink so a test can push events mid-turn. */
let emit: ((ev: AgentStreamEvent) => void) | null = null;

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	emit = null;
	vi.mocked(api.sessions.messages).mockResolvedValue({ messages: [] });
	vi.mocked(api.sessions.queuedMessages).mockResolvedValue({ queued: [] });
	vi.mocked(api.sessions.changedFiles).mockResolvedValue({ files: [] });
	vi.mocked(api.sessions.commits).mockResolvedValue({ commits: [] });
	vi.mocked(api.sessions.artefacts).mockResolvedValue({ artefacts: [] });
	vi.mocked(api.sessions.stream).mockImplementation((_id, onEvent, onOpen) => {
		emit = onEvent;
		onOpen?.();
		return () => {};
	});
	URL.createObjectURL = vi.fn(() => "blob:preview");
	URL.revokeObjectURL = vi.fn();
});

function renderShell() {
	return render(
		<ChatShell sessionId="sess-1" session={session} isDesktop={true} />,
	);
}

describe("an image the Agent sends mid-turn", () => {
	it("renders as soon as image_sent arrives, before the turn ends", async () => {
		renderShell();
		await waitFor(() => expect(emit).not.toBeNull());

		emit?.({ type: "message_start", messageId: "m1", role: "assistant" });
		emit?.({ type: "token", messageId: "m1", chunk: "Here it is:" });
		emit?.({
			type: "image_sent",
			messageId: "m1",
			attachment: makeAttachment({ filename: "shot.png" }),
		});

		// No message_end, no terminal status, no refetch — the picture must be
		// on screen purely from the live event.
		expect(await screen.findByAltText("shot.png")).toBeTruthy();
		expect(screen.getByText("Here it is:")).toBeTruthy();
	});

	it("keeps the image between the prose before and after it", async () => {
		renderShell();
		await waitFor(() => expect(emit).not.toBeNull());

		emit?.({ type: "message_start", messageId: "m1", role: "assistant" });
		emit?.({ type: "token", messageId: "m1", chunk: "Before the image." });
		emit?.({
			type: "image_sent",
			messageId: "m1",
			attachment: makeAttachment({ filename: "middle.png" }),
		});
		emit?.({ type: "token", messageId: "m1", chunk: "After the image." });

		const img = await screen.findByAltText("middle.png");
		const before = await screen.findByText("Before the image.");
		const after = await screen.findByText("After the image.");

		// DOCUMENT_POSITION_FOLLOWING === 4: each node precedes the next, so
		// the picture sits between the two prose parts rather than at the end.
		expect(before.compareDocumentPosition(img) & 4).toBeTruthy();
		expect(img.compareDocumentPosition(after) & 4).toBeTruthy();
	});
});
