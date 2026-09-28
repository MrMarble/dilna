import type { Message, SeedTrimView, SessionView } from "@dilna/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api/client";
import { ChatShell } from "@/components/ChatShell";
import type { PartialApi } from "@/test/api-mock";
import { makeSession as sharedMakeSession } from "@/test/factories";

/**
 * The transcript's truncation markers (issue #273): a tool_call part the
 * seed policy would trim renders its *seeded* form with the marker line
 * shown explicitly, plus a read-only link to the stored original — and it
 * does so from the GET /messages trim map (persisted state), so it survives
 * a reload rather than being a live-event artifact.
 *
 * The API module is mocked wholesale — this is about rendering, not the
 * network.
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
			scores: async () => ({ scores: [] }),
			get: vi.fn(),
		},
		skills: {
			forRepo: vi.fn(async () => ({ skills: [] })),
		},
	} satisfies PartialApi,
}));

const HASH = "a".repeat(64);

function makeSession(status: SessionView["status"]): SessionView {
	return sharedMakeSession({ status, title: "Test session" });
}

const HEAD = Array.from({ length: 40 }, (_, i) => `head line ${i}`).join("\n");
const TAIL = Array.from({ length: 30 }, (_, i) => `tail line ${i}`).join("\n");
const MARKER = `[dilna trimmed this tool output: read of src/big.ts — 330 lines removed; content sha256 ${HASH.slice(0, 16)}]`;
const ORIGINAL = Array.from({ length: 400 }, (_, i) => `full line ${i}`).join(
	"\n",
);

const readRow: Message = {
	id: "m1",
	sessionId: "sess-1",
	role: "assistant",
	parts: [
		{ type: "text", text: "Reading the file." },
		{
			type: "tool_call",
			callId: "call-1",
			tool: "read",
			input: { path: "src/big.ts" },
			output: ORIGINAL,
		},
	],
	turnId: "turn-1",
	createdAt: 1,
};

const trimView: SeedTrimView = {
	hash: HASH,
	seeded: `${HEAD}\n${MARKER}\n${TAIL}`,
	originalLines: 400,
	originalChars: ORIGINAL.length,
	seededLines: 71,
	reason: "size",
};

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	vi.mocked(api.sessions.queuedMessages).mockResolvedValue({ queued: [] });
	// History is fetched by the on-open resync routine (ADR-0016 §4), so the
	// fake stream must fire `onOpen` for the transcript to load at all.
	vi.mocked(api.sessions.stream).mockImplementation((_id, _onEvent, onOpen) => {
		onOpen?.();
		return () => {};
	});
});

function renderShell(status: SessionView["status"] = "idle") {
	return render(
		<ChatShell
			sessionId="sess-1"
			session={makeSession(status)}
			isDesktop={true}
		/>,
	);
}

describe("truncation markers in the transcript (issue #273)", () => {
	it("renders the seeded form and a view-original link on a trimmed part", async () => {
		vi.mocked(api.sessions.messages).mockResolvedValue({
			messages: [readRow],
			trims: { "call-1": trimView },
		});
		renderShell();

		await waitFor(() =>
			expect(screen.getByText("Reading the file.")).toBeDefined(),
		);
		// The tool group starts collapsed for history rows — expand it, then
		// open the individual tool row (details are collapsed one more level).
		await userEvent.click(screen.getByText(/1 tool call/));
		await userEvent.click(screen.getByText("src/big.ts"));

		// The verbatim original is NOT what's on screen; the seeded form is.
		expect(screen.queryByText(/full line 399/)).toBeNull();
		expect(screen.getByText(/head line 0/)).toBeDefined();
		// The marker line is shown explicitly — that's what names the hash.
		expect(screen.getByText(/dilna trimmed this tool output/)).toBeDefined();
		// The link opens the stored original, read-only, in a new tab.
		const link = screen.getByText("View original").closest("a");
		expect(link?.getAttribute("href")).toBe(
			`/api/sessions/sess-1/truncated/${HASH}`,
		);
		expect(link?.getAttribute("target")).toBe("_blank");
	});

	it("shows a dedup trim with the dedup wording", async () => {
		vi.mocked(api.sessions.messages).mockResolvedValue({
			messages: [readRow],
			trims: {
				"call-1": {
					...trimView,
					seeded: MARKER,
					seededLines: 1,
					reason: "dedup",
				},
			},
		});
		renderShell();
		await waitFor(() =>
			expect(screen.getByText("Reading the file.")).toBeDefined(),
		);
		await userEvent.click(screen.getByText(/1 tool call/));
		await userEvent.click(screen.getByText("src/big.ts"));
		expect(
			screen.getByText(
				"Identical to an earlier result — the model sees only the marker",
			),
		).toBeDefined();
	});

	it("leaves an untrimmed part verbatim, with no marker and no link", async () => {
		vi.mocked(api.sessions.messages).mockResolvedValue({
			messages: [readRow],
			trims: {},
		});
		renderShell();
		await waitFor(() =>
			expect(screen.getByText("Reading the file.")).toBeDefined(),
		);
		await userEvent.click(screen.getByText(/1 tool call/));
		await userEvent.click(screen.getByText("src/big.ts"));
		expect(screen.getByText(/full line 399/)).toBeDefined();
		expect(screen.queryByText("View original")).toBeNull();
	});

	it("picks up a trim that arrives with the post-turn reconcile refetch", async () => {
		// On-open load: the turn is fresh, nothing trimmed yet. The reconcile
		// refetch after the turn's terminal status: same row, now trimmed —
		// the trim map is recomputed from persisted rows server-side, so it
		// appears without a full page reload.
		vi.mocked(api.sessions.messages)
			.mockResolvedValueOnce({ messages: [readRow] })
			.mockResolvedValueOnce({
				messages: [readRow],
				trims: { "call-1": trimView },
			});
		// Replay a working→idle transition on subscribe, the way joining
		// mid-turn then seeing the turn end looks.
		vi.mocked(api.sessions.stream).mockImplementation(
			(_id, onEvent, onOpen) => {
				onOpen?.();
				queueMicrotask(() => {
					onEvent({ type: "session_status", status: "working" });
					onEvent({ type: "session_status", status: "idle" });
				});
				return () => {};
			},
		);
		renderShell("idle");

		await waitFor(() => expect(api.sessions.messages).toHaveBeenCalledTimes(2));
		await userEvent.click(screen.getByText(/1 tool call/));
		await userEvent.click(screen.getByText("src/big.ts"));
		// The trimmed view replaced the verbatim row.
		expect(screen.queryByText(/full line 399/)).toBeNull();
		expect(screen.getByText(/dilna trimmed this tool output/)).toBeDefined();
	});
});
