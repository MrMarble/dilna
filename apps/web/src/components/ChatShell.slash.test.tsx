import type { RepoSkill, SessionView } from "@dilna/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import { ChatShell } from "@/components/ChatShell";

/**
 * The composer's slash-command menu: typing `/` on an empty composer lists
 * the Skills this Repo has enabled so the user picks one instead of recalling
 * its name from memory.
 *
 * The API module is mocked wholesale — this is about the composer's own
 * behaviour, not the network.
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
		skills: {
			forRepo: vi.fn(),
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

function skill(name: string, enabled = true): RepoSkill {
	return {
		id: `owner/repo/${name}`,
		source: "owner/repo",
		slug: name,
		name,
		description: `does ${name}`,
		sourceUrl: `https://github.com/owner/repo/${name}`,
		installedAt: 1,
		enabled,
	};
}

function renderShell() {
	return render(<ChatShell sessionId="sess-1" session={session} isDesktop />);
}

/** The composer textarea, whichever placeholder it currently shows. */
function composer() {
	return screen.getByRole("textbox");
}

beforeEach(() => {
	localStorage.clear();
	vi.mocked(api.sessions.messages).mockResolvedValue({ messages: [] });
	vi.mocked(api.sessions.queuedMessages).mockResolvedValue({ queued: [] });
	vi.mocked(api.sessions.stream).mockReturnValue(() => {});
	vi.mocked(api.sessions.send).mockResolvedValue({
		ok: true,
		message: {
			id: "m1",
			sessionId: "sess-1",
			turnId: "turn-1",
			role: "user",
			parts: [],
			createdAt: 1,
		},
	});
	vi.mocked(api.skills.forRepo).mockResolvedValue({
		skills: [skill("code-review"), skill("verify"), skill("grill-me")],
	});
});

describe("ChatShell slash-command menu", () => {
	it("lists the Repo's enabled Skills when `/` opens the composer", async () => {
		const user = userEvent.setup();
		renderShell();
		await waitFor(() =>
			expect(api.skills.forRepo).toHaveBeenCalledWith("repo-1"),
		);

		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

		await user.type(composer(), "/");

		const options = await screen.findAllByRole("option");
		expect(options.map((o) => o.textContent)).toEqual([
			expect.stringContaining("code-review"),
			expect.stringContaining("verify"),
			expect.stringContaining("grill-me"),
		]);
	});

	it("filters as more characters are typed", async () => {
		const user = userEvent.setup();
		renderShell();
		await waitFor(() => expect(api.skills.forRepo).toHaveBeenCalled());

		await user.type(composer(), "/ver");

		const options = await screen.findAllByRole("option");
		expect(options).toHaveLength(1);
		expect(options[0]).toHaveTextContent("verify");
	});

	it("closes when the query matches no Skill", async () => {
		const user = userEvent.setup();
		renderShell();
		await waitFor(() => expect(api.skills.forRepo).toHaveBeenCalled());

		await user.type(composer(), "/zzz");

		await waitFor(() =>
			expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
		);
	});

	it("completes the Skill on click and closes the menu", async () => {
		const user = userEvent.setup();
		renderShell();
		await waitFor(() => expect(api.skills.forRepo).toHaveBeenCalled());

		await user.type(composer(), "/rev");
		await user.click(
			await screen.findByRole("option", { name: /code-review/ }),
		);

		expect(composer()).toHaveValue("/code-review ");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});

	it("closes on the space after a command, leaving the text intact", async () => {
		const user = userEvent.setup();
		renderShell();
		await waitFor(() => expect(api.skills.forRepo).toHaveBeenCalled());

		await user.type(composer(), "/verify");
		expect(await screen.findByRole("listbox")).toBeInTheDocument();

		await user.type(composer(), " ");

		await waitFor(() =>
			expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
		);
		expect(composer()).toHaveValue("/verify ");
	});

	it("accepts the arrow-selected Skill with Enter instead of sending", async () => {
		const user = userEvent.setup();
		renderShell();
		await waitFor(() => expect(api.skills.forRepo).toHaveBeenCalled());

		await user.type(composer(), "/");
		await screen.findAllByRole("option");
		await user.keyboard("{ArrowDown}{Enter}");

		expect(composer()).toHaveValue("/verify ");
		expect(api.sessions.send).not.toHaveBeenCalled();
	});

	it("dismisses on Escape without reopening on the next keystroke", async () => {
		const user = userEvent.setup();
		renderShell();
		await waitFor(() => expect(api.skills.forRepo).toHaveBeenCalled());

		await user.type(composer(), "/ver");
		expect(await screen.findByRole("listbox")).toBeInTheDocument();

		await user.keyboard("{Escape}");
		await waitFor(() =>
			expect(screen.queryByRole("listbox")).not.toBeInTheDocument(),
		);

		await user.type(composer(), "i");
		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});

	it("leaves a mid-message slash alone", async () => {
		const user = userEvent.setup();
		renderShell();
		await waitFor(() => expect(api.skills.forRepo).toHaveBeenCalled());

		await user.type(composer(), "look in src/lib");

		expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
	});

	it("omits Skills the Repo has not enabled", async () => {
		vi.mocked(api.skills.forRepo).mockResolvedValue({
			skills: [skill("code-review"), skill("disabled-one", false)],
		});
		const user = userEvent.setup();
		renderShell();
		await waitFor(() => expect(api.skills.forRepo).toHaveBeenCalled());

		await user.type(composer(), "/");

		const options = await screen.findAllByRole("option");
		expect(options).toHaveLength(1);
		expect(options[0]).toHaveTextContent("code-review");
	});
});
