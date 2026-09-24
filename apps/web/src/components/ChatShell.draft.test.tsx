import type { SessionView } from "@dilna/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import { ChatShell } from "@/components/ChatShell";
import type { PartialApi } from "@/test/api-mock";
import { makeSession as sharedMakeSession } from "@/test/factories";

/**
 * Composer draft persistence (issue: navigating to another Session or view
 * lost the half-written message): drafts are localStorage-backed per
 * Session, restored on mount, flushed on unmount/switch, and dropped once
 * the send is accepted.
 *
 * The API module is mocked wholesale — this is about the composer's own
 * behaviour, not the network.
 */

// Plain factory (no `importOriginal` spread) — matching the other web
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
			uploadAttachment: vi.fn(),
			stop: vi.fn(),
			stream: vi.fn(),
			changedFiles: vi.fn(),
			commits: vi.fn(),
			artefacts: vi.fn(),
			scores: async () => ({ scores: [] }),
			get: vi.fn(),
		},
		// The composer reads the Repo's Skills for its slash-command menu.
		skills: {
			forRepo: vi.fn(async () => ({ skills: [] })),
		},
	} satisfies PartialApi,
}));

function makeSession(id: string): SessionView {
	return sharedMakeSession({ id, title: "Test session" });
}

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	vi.mocked(api.sessions.messages).mockResolvedValue({ messages: [] });
	// History is fetched by the on-open resync routine (ADR-0016 §4), not by
	// a mount effect — the fake stream has to fire `onOpen` or the chat
	// renders permanently empty.
	vi.mocked(api.sessions.stream).mockImplementation((_id, _onEvent, onOpen) => {
		onOpen?.();
		return () => {};
	});
});

function renderShell(sessionId = "sess-1") {
	return render(
		<ChatShell
			sessionId={sessionId}
			session={makeSession(sessionId)}
			isDesktop={true}
		/>,
	);
}

describe("composer draft persistence", () => {
	it("saves the typed draft to localStorage (debounced)", async () => {
		renderShell();
		await userEvent.type(screen.getByRole("textbox"), "half-written thought");
		// The write is debounced — poll until it lands rather than sleeping.
		await waitFor(() => {
			expect(localStorage.getItem("dilna:draft:sess-1")).toBe(
				"half-written thought",
			);
		});
	});

	it("restores the persisted draft on mount", async () => {
		localStorage.setItem("dilna:draft:sess-1", "welcome back");
		renderShell();
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
			"welcome back",
		);
	});

	// Navigation to Settings/Metrics/home unmounts ChatShell before the
	// debounce fires — the tail must be flushed, not lost.
	it("flushes the pending draft on unmount", async () => {
		const { unmount } = renderShell();
		await userEvent.type(screen.getByRole("textbox"), "typed then navigated");
		unmount();
		expect(localStorage.getItem("dilna:draft:sess-1")).toBe(
			"typed then navigated",
		);
	});

	// Session switch re-keys ChatShell's props without a remount: each
	// Session keeps its own draft, and the outgoing one's tail is flushed.
	it("keeps drafts separate across a Session switch", async () => {
		localStorage.setItem("dilna:draft:sess-2", "draft for two");
		const { rerender } = renderShell("sess-1");
		await userEvent.type(screen.getByRole("textbox"), "draft for one");

		rerender(
			<ChatShell
				sessionId="sess-2"
				session={makeSession("sess-2")}
				isDesktop={true}
			/>,
		);

		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
			"draft for two",
		);
		// The first Session's not-yet-debounced tail was written at the switch.
		expect(localStorage.getItem("dilna:draft:sess-1")).toBe("draft for one");

		rerender(
			<ChatShell
				sessionId="sess-1"
				session={makeSession("sess-1")}
				isDesktop={true}
			/>,
		);
		expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
			"draft for one",
		);
	});

	it("clears the persisted draft once the send is accepted", async () => {
		vi.mocked(api.sessions.send).mockResolvedValue({
			ok: true,
			message: {
				id: "m1",
				sessionId: "sess-1",
				role: "user",
				parts: [{ type: "text", text: "ship it" }],
				turnId: null,
				createdAt: 1,
			},
		});
		renderShell();

		const textarea = screen.getByRole("textbox");
		await userEvent.type(textarea, "ship it");
		await waitFor(() => {
			expect(localStorage.getItem("dilna:draft:sess-1")).toBe("ship it");
		});

		await userEvent.type(textarea, "{Enter}");
		await waitFor(() => {
			expect(api.sessions.send).toHaveBeenCalledWith("sess-1", "ship it", []);
		});
		expect((textarea as HTMLTextAreaElement).value).toBe("");
		expect(localStorage.getItem("dilna:draft:sess-1")).toBeNull();
	});

	// A rejected send must keep the draft — the message never reached the
	// server, so clearing it would destroy the only copy.
	it("keeps the draft when the send fails", async () => {
		vi.mocked(api.sessions.send).mockRejectedValue(new Error("boom"));
		renderShell();

		const textarea = screen.getByRole("textbox");
		await userEvent.type(textarea, "precious words{Enter}");
		// The error marker itself only renders once the transcript is non-empty
		// (an empty chat shows EmptyHint instead) — so wait on the rejected call,
		// not on the error text.
		await waitFor(() => {
			expect(api.sessions.send).toHaveBeenCalledWith(
				"sess-1",
				"precious words",
				[],
			);
		});

		expect((textarea as HTMLTextAreaElement).value).toBe("precious words");
		await waitFor(() => {
			expect(localStorage.getItem("dilna:draft:sess-1")).toBe("precious words");
		});
	});
});
