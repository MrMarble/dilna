import type { Attachment, SessionView } from "@dilna/shared";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import { ChatShell } from "@/components/ChatShell";

/**
 * The composer's attachment affordances (issue #53): the two-row layout's
 * Plus button, the pending tray, and how a sent attachment renders in the
 * transcript.
 *
 * The API module is mocked wholesale — this is about the composer's own
 * behaviour, not the network.
 */

// Plain factory (no `importOriginal` spread) — matching SettingsPage.test's
// convention, and the only shape where the `api` override reliably wins for
// *every* importer, including `usePendingAttachments`.
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
			get: vi.fn(),
		},
	},
}));

const session: SessionView = {
	id: "sess-1",
	repoId: "repo-1",
	title: "Test session",
	agentType: "pi",
	kind: "session",
	status: "idle",
	usage: { inputTokens: 0, outputTokens: 0 },
	createdAt: 1,
	lastActiveAt: 1,
};

function makeAttachment(overrides: Partial<Attachment> = {}): Attachment {
	return {
		id: "att-1",
		sessionId: "sess-1",
		filename: "diagram.png",
		mimeType: "image/png",
		size: 2048,
		kind: "image",
		path: "/data/attachments/sess-1/abc-diagram.png",
		createdAt: 1,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(api.sessions.messages).mockResolvedValue({ messages: [] });
	vi.mocked(api.sessions.changedFiles).mockResolvedValue({ files: [] });
	vi.mocked(api.sessions.commits).mockResolvedValue({ commits: [] });
	// History is fetched by the on-open resync routine (ADR-0016 §4), not by
	// a mount effect — so the fake stream has to fire `onOpen` or the chat
	// renders permanently empty.
	vi.mocked(api.sessions.stream).mockImplementation((_id, _onEvent, onOpen) => {
		onOpen?.();
		return () => {};
	});
	// jsdom implements neither of these, and the tray creates a preview URL
	// for every image the user picks.
	URL.createObjectURL = vi.fn(() => "blob:preview");
	URL.revokeObjectURL = vi.fn();
});

function renderShell() {
	return render(
		<ChatShell sessionId="sess-1" session={session} isDesktop={true} />,
	);
}

/**
 * Drive the composer's file input directly. `userEvent.upload` refuses an
 * input it considers unclickable, and this one is deliberately `hidden`
 * (it's opened by the Plus button, never clicked itself) — so the change
 * event is dispatched here instead, which is exactly what the browser does
 * once the native picker closes.
 */
function pickFiles(...files: File[]) {
	const input = document.querySelector(
		'input[type="file"]',
	) as HTMLInputElement;
	Object.defineProperty(input, "files", {
		value: files,
		configurable: true,
	});
	fireEvent.change(input);
}

describe("composer attachments", () => {
	it("offers an attach button next to the send button", async () => {
		renderShell();
		expect(
			await screen.findByRole("button", { name: /attach files/i }),
		).toBeTruthy();
		expect(screen.getByTitle("Send")).toBeTruthy();
	});

	it("uploads a picked file and shows it in the tray", async () => {
		const attachment = makeAttachment();
		vi.mocked(api.sessions.uploadAttachment).mockResolvedValue(attachment);
		renderShell();

		const file = new File(["bytes"], "diagram.png", { type: "image/png" });
		pickFiles(file);

		expect(await screen.findByText("diagram.png")).toBeTruthy();
		await waitFor(() => {
			expect(api.sessions.uploadAttachment).toHaveBeenCalledWith(
				"sess-1",
				file,
			);
		});
	});

	// A vanished row reads as the app losing the file; the user dismisses it.
	it("keeps a failed upload visible in the tray with its error", async () => {
		vi.mocked(api.sessions.uploadAttachment).mockRejectedValue(
			new Error("file exceeds the 4MB limit"),
		);
		renderShell();

		pickFiles(new File(["bytes"], "huge.png", { type: "image/png" }));

		expect(await screen.findByText("huge.png")).toBeTruthy();
		expect(await screen.findByText(/exceeds the 4MB limit/)).toBeTruthy();
	});

	it("removes a tray entry when its remove button is clicked", async () => {
		vi.mocked(api.sessions.uploadAttachment).mockResolvedValue(
			makeAttachment(),
		);
		renderShell();

		pickFiles(new File(["bytes"], "diagram.png", { type: "image/png" }));
		await screen.findByText("diagram.png");

		await userEvent.click(
			screen.getByRole("button", { name: /remove diagram\.png/i }),
		);

		await waitFor(() => {
			expect(screen.queryByText("diagram.png")).toBeNull();
		});
	});

	// Issue #53's "drag a file/image into the prompt".
	it("attaches files dropped onto the composer", async () => {
		const attachment = makeAttachment();
		vi.mocked(api.sessions.uploadAttachment).mockResolvedValue(attachment);
		renderShell();

		const file = new File(["bytes"], "dropped.png", { type: "image/png" });
		const composer = screen.getByRole("textbox").parentElement as HTMLElement;
		const dataTransfer = { files: [file], types: ["Files"] };

		fireEvent.dragEnter(composer, { dataTransfer });
		fireEvent.dragOver(composer, { dataTransfer });
		fireEvent.drop(composer, { dataTransfer });

		await waitFor(() => {
			expect(api.sessions.uploadAttachment).toHaveBeenCalledWith(
				"sess-1",
				file,
			);
		});
		expect(await screen.findByText("dropped.png")).toBeTruthy();
	});

	// Dragged text should still land in the textarea rather than being
	// swallowed as a (nonexistent) file drop.
	it("ignores a drop that carries no files", async () => {
		renderShell();
		const composer = screen.getByRole("textbox").parentElement as HTMLElement;

		fireEvent.drop(composer, {
			dataTransfer: { files: [], types: ["text/plain"] },
		});

		expect(api.sessions.uploadAttachment).not.toHaveBeenCalled();
	});

	// A failed upload stays in the tray on purpose, so treating it as "not
	// ready" would wedge the composer: a typed draft could not be sent until
	// the user spotted the small remove button.
	it("still sends the text when one upload failed", async () => {
		vi.mocked(api.sessions.uploadAttachment).mockRejectedValue(
			new Error("upload failed"),
		);
		vi.mocked(api.sessions.send).mockResolvedValue({
			ok: true,
			message: {
				id: "m1",
				sessionId: "sess-1",
				role: "user",
				parts: [{ type: "text", text: "send anyway" }],
				turnId: null,
				createdAt: 1,
			},
		});
		renderShell();

		pickFiles(new File(["bytes"], "doomed.png", { type: "image/png" }));
		await screen.findByText(/upload failed/);

		const textarea = screen.getByRole("textbox");
		await userEvent.type(textarea, "send anyway");

		const send = screen.getByTitle("Send");
		expect((send as HTMLButtonElement).disabled).toBe(false);

		await userEvent.click(send);
		await waitFor(() => {
			// The errored file is simply left behind, not sent.
			expect(api.sessions.send).toHaveBeenCalledWith(
				"sess-1",
				"send anyway",
				[],
			);
		});
	});

	it("blocks sending only while an upload is still in flight", async () => {
		// A promise that never settles — the upload stays "uploading".
		vi.mocked(api.sessions.uploadAttachment).mockReturnValue(
			new Promise(() => {}),
		);
		renderShell();

		pickFiles(new File(["bytes"], "slow.png", { type: "image/png" }));
		await screen.findByText("Uploading…");

		await userEvent.type(screen.getByRole("textbox"), "wait for it");
		expect((screen.getByTitle("Send") as HTMLButtonElement).disabled).toBe(
			true,
		);
	});

	// "Look at this" with no words is a real message.
	it("sends an attachment-only message with no text", async () => {
		const attachment = makeAttachment();
		vi.mocked(api.sessions.uploadAttachment).mockResolvedValue(attachment);
		vi.mocked(api.sessions.send).mockResolvedValue({
			ok: true,
			message: {
				id: "m1",
				sessionId: "sess-1",
				role: "user",
				parts: [{ type: "attachment", attachment }],
				turnId: null,
				createdAt: 1,
			},
		});
		renderShell();

		pickFiles(new File(["bytes"], "diagram.png", { type: "image/png" }));
		await screen.findByText("diagram.png");

		await userEvent.click(screen.getByTitle("Send"));

		await waitFor(() => {
			expect(api.sessions.send).toHaveBeenCalledWith("sess-1", "", ["att-1"]);
		});
	});
});

describe("rendering a sent attachment", () => {
	it("renders an image attachment as a picture pointing at the bytes route", async () => {
		const attachment = makeAttachment();
		vi.mocked(api.sessions.messages).mockResolvedValue({
			messages: [
				{
					id: "m1",
					sessionId: "sess-1",
					role: "user",
					parts: [
						{ type: "attachment", attachment },
						{ type: "text", text: "what's wrong here?" },
					],
					turnId: null,
					createdAt: 1,
				},
			],
		});
		renderShell();

		const img = (await screen.findByAltText("diagram.png")) as HTMLImageElement;
		expect(img.getAttribute("src")).toBe(
			"/api/sessions/sess-1/attachments/att-1",
		);
		expect(await screen.findByText("what's wrong here?")).toBeTruthy();
	});

	// Rich previews are a separate task; a name-and-icon card is the honest
	// placeholder until then.
	it("renders a document attachment as a card with its name and size", async () => {
		vi.mocked(api.sessions.messages).mockResolvedValue({
			messages: [
				{
					id: "m1",
					sessionId: "sess-1",
					role: "user",
					parts: [
						{
							type: "attachment",
							attachment: makeAttachment({
								id: "att-2",
								filename: "spec.pdf",
								mimeType: "application/pdf",
								kind: "document",
								size: 1024 * 1024,
							}),
						},
					],
					turnId: null,
					createdAt: 1,
				},
			],
		});
		renderShell();

		expect(await screen.findByText("spec.pdf")).toBeTruthy();
		expect(await screen.findByText("1.0 MB")).toBeTruthy();
		expect(screen.queryByAltText("spec.pdf")).toBeNull();
	});
});
