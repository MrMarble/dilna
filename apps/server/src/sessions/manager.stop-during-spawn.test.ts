import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { repoManager } from "../repos/manager";
import { sessionManager } from "./manager";

const execFileAsync = promisify(execFile);
const git = (args: string[], opts?: { cwd?: string }) =>
	execFileAsync("git", args, { ...opts, maxBuffer: 50 * 1024 * 1024 });

// Stub out the pi agent backend entirely: the stop-during-spawn path we're
// exercising returns before ever dispatching to the model, so the only thing
// the adapter needs to do is hand back a warm handle from startPi.
vi.mock("../agents/pi", () => {
	const handle = {
		kind: "pi",
		worktreePath: "",
		agent: { state: { messages: [] } },
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
	};
});

let dataDir: string;
let fixtureRepo: string;
let oldDataDir: string | undefined;

beforeAll(async () => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-stop-"));
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
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(fixtureRepo, { recursive: true, force: true });
});

describe("stop during cold spawn", () => {
	it("promotes the pending user placeholder instead of leaking it", async () => {
		const repo = await repoManager.clone(fixtureRepo, `stop-${Date.now()}`);
		const session = await sessionManager.create(repo.id);
		const id = session.id;

		// Claim the turn slot and persist the pending-user placeholder.
		sessionManager.beginTurn(id, "turn that will be stopped");

		// A Stop request lands while the (cold) agent is still spawning: it
		// flips stopRequested before runTurn reaches the post-spawn check.
		await sessionManager.requestStop(id);

		// runTurn spawns the mocked agent, sees stopRequested, and must promote
		// the placeholder (not leave the pending-user-<id> row behind).
		await sessionManager.runTurn(id, "turn that will be stopped");

		// The pending placeholder must be gone; the user's message must survive
		// as a permanent row under a fresh non-placeholder id.
		const messages = await sessionManager.getMessages(id);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.role).toBe("user");
		expect(messages[0]?.id).not.toBe(`pending-user-${id}`);
		expect(messages[0]?.id).not.toContain("pending-user");

		// And a subsequent send must not collide on the placeholder primary key.
		expect(() => sessionManager.beginTurn(id, "next turn")).not.toThrow();

		await sessionManager.delete(id);
		await repoManager.delete(repo.id);
	});
});
