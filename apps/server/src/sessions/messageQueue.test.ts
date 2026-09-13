import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentStreamEvent } from "@dilna/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb } from "../db";
import { repoManager } from "../repos/manager";
import { sessionManager } from "./manager";
import {
	deleteQueueForSession,
	enqueueMessage,
	listQueuedMessages,
	removeQueuedMessage,
	removeQueuedMessagesById,
} from "./messageQueue";

const execFileAsync = promisify(execFile);
const git = (args: string[], opts?: { cwd?: string }) =>
	execFileAsync("git", args, { ...opts, maxBuffer: 50 * 1024 * 1024 });

// Stub out the pi agent backend: the queue's contract is about what happens
// *around* a turn (accept while busy, drain at the boundary), not what the
// model says during one — `chatPi` resolving immediately is a turn that
// completes instantly with no output, which is all the drain needs.
vi.mock("../agents/pi", () => {
	const handle = {
		kind: "pi",
		worktreePath: "",
		provider: "anthropic",
		model: "claude-test",
		agent: {
			state: { messages: [] },
			// runTurn's incremental-persistence subscription (ADR-0026) — a
			// no-op unsubscribe is enough with no rounds ever emitted.
			subscribe: vi.fn().mockReturnValue(() => {}),
		},
		listeners: new Set(),
		stop: vi.fn().mockResolvedValue(undefined),
		isAlive: vi.fn().mockReturnValue(true),
		stderrTail: [],
	};
	return {
		startPi: vi.fn().mockResolvedValue(handle),
		startOrchestrator: vi.fn().mockResolvedValue(handle),
		chatPi: vi.fn().mockResolvedValue(undefined),
		generateSessionTitle: vi.fn().mockResolvedValue(null),
		dilnaMessagesToInitialState: vi.fn().mockReturnValue([]),
		piMessagesToDilna: vi.fn().mockReturnValue([]),
		piRoundToDilnaMessage: vi.fn().mockReturnValue(null),
		// Consulted by the turn-end compaction check — null means "model not
		// in catalog", which makes that check a quiet no-op instead of an
		// unhandled-mock error in the logs.
		resolveSummarizationModel: vi.fn().mockReturnValue(null),
	};
});

let dataDir: string;
let fixtureRepo: string;
let oldDataDir: string | undefined;

beforeAll(async () => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-queue-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;
	fixtureRepo = mkdtempSync(path.join(tmpdir(), "dilna-fixture-"));
	await git(["init", "-b", "main", fixtureRepo]);
	await git(["config", "user.email", "test@dilna.local"], { cwd: fixtureRepo });
	await git(["config", "user.name", "dilna test"], { cwd: fixtureRepo });
	writeFileSync(path.join(fixtureRepo, "README.md"), "# fixture\n");
	await git(["add", "."], { cwd: fixtureRepo });
	await git(["commit", "-m", "initial"], { cwd: fixtureRepo });
});

afterAll(() => {
	closeDb();
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(fixtureRepo, { recursive: true, force: true });
});

describe("messageQueue store", () => {
	it("lists in enqueue order and removes by id", () => {
		const sid = "store-session-1";
		const a = enqueueMessage(sid, "first", []);
		const b = enqueueMessage(sid, "second", []);
		enqueueMessage("other-session", "not mine", []);

		expect(listQueuedMessages(sid).map((e) => e.text)).toEqual([
			"first",
			"second",
		]);

		expect(removeQueuedMessage(sid, a.id)).toBe(true);
		// Already gone — idempotent false, not an error.
		expect(removeQueuedMessage(sid, a.id)).toBe(false);
		// Wrong session can't remove another session's entry.
		expect(removeQueuedMessage("other-session", b.id)).toBe(false);
		expect(listQueuedMessages(sid).map((e) => e.text)).toEqual(["second"]);

		removeQueuedMessagesById(sid, [b.id]);
		expect(listQueuedMessages(sid)).toEqual([]);
		expect(listQueuedMessages("other-session")).toHaveLength(1);
		deleteQueueForSession("other-session");
		expect(listQueuedMessages("other-session")).toEqual([]);
	});
});

describe("queue dispatch at the turn boundary (ADR-0033)", () => {
	it("holds entries while a turn is in flight, then drains them all into one combined turn", async () => {
		const repo = await repoManager.clone(fixtureRepo, `queue-a-${Date.now()}`);
		const session = await sessionManager.create(repo.id);
		const id = session.id;

		const events: AgentStreamEvent[] = [];
		const unsubscribe = sessionManager.subscribe(id, (ev) => events.push(ev));

		// Claim the turn slot the way a real send does — the queue must not
		// dispatch while it's held.
		sessionManager.beginTurn(id, "the in-flight turn");
		sessionManager.enqueueMessage(id, "also do A", []);
		sessionManager.enqueueMessage(id, "and B", []);
		expect(sessionManager.listQueuedMessages(id)).toHaveLength(2);

		// Every enqueue broadcasts the whole queue (level-based).
		const queueUpdates = events.filter((e) => e.type === "queue_update");
		expect(queueUpdates.at(-1)).toMatchObject({
			queued: [{ text: "also do A" }, { text: "and B" }],
		});

		// The in-flight turn ends → its exit path drains the queue.
		await sessionManager.runTurn(id, "the in-flight turn");

		await vi.waitFor(async () => {
			expect(sessionManager.listQueuedMessages(id)).toEqual([]);
			const messages = await sessionManager.getMessages(id);
			// One combined user message for the whole batch — texts joined,
			// not one turn per entry.
			expect(
				messages.filter((m) => m.role === "user").map((m) => m.parts),
			).toEqual([
				[{ type: "text", text: "the in-flight turn" }],
				[{ type: "text", text: "also do A\n\nand B" }],
			]);
		});
		// The drain announced itself to every subscriber.
		expect(
			events.some((e) => e.type === "queue_update" && e.queued.length === 0),
		).toBe(true);
		unsubscribe();
	});

	it("dispatches immediately when enqueued against an idle session", async () => {
		const repo = await repoManager.clone(fixtureRepo, `queue-b-${Date.now()}`);
		const session = await sessionManager.create(repo.id);
		const id = session.id;

		// The client queues on a stale status snapshot (the turn ended between
		// its render and its POST) — the entry must not strand until some
		// later turn happens to end.
		sessionManager.enqueueMessage(id, "raced the turn end", []);

		await vi.waitFor(async () => {
			expect(sessionManager.listQueuedMessages(id)).toEqual([]);
			const messages = await sessionManager.getMessages(id);
			expect(
				messages.some(
					(m) =>
						m.role === "user" &&
						m.parts.some(
							(p) => p.type === "text" && p.text === "raced the turn end",
						),
				),
			).toBe(true);
		});
	});
});
