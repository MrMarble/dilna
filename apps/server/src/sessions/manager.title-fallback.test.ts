import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { generateSessionTitle } from "../agents/pi";
import { createServerContext } from "../container";
import { fallbackSessionTitle } from "./sessionStore";

const execFileAsync = promisify(execFile);
const git = (args: string[], opts?: { cwd?: string }) =>
	execFileAsync("git", args, { ...opts, maxBuffer: 50 * 1024 * 1024 });

/**
 * Stub out the pi agent backend entirely, like manager.stop-during-spawn
 * does — these tests exercise `maybeDeriveTitle`'s two-tier composition
 * (model-derived title, then the deterministic prompt fallback), not the
 * agent itself. `generateSessionTitle`'s resolved value is what varies; the
 * mock is reached through the module import below (a `vi.mock` factory may
 * not close over file-level variables).
 */
vi.mock("../agents/pi", () => {
	const handle = {
		kind: "pi",
		worktreePath: "",
		agent: {
			state: { messages: [] },
			// runTurn subscribes for the turn's duration; the stub emits nothing.
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
		piRoundToDilnaMessage: vi.fn().mockReturnValue([]),
		resolveSummarizationModel: vi.fn().mockReturnValue(undefined),
		summarizeMessages: vi.fn().mockResolvedValue(null),
		judgeComplete: vi.fn().mockResolvedValue(null),
	};
});

let dataDir: string;
let fixtureRepo: string;
let oldDataDir: string | undefined;

let repoManager: ReturnType<typeof createServerContext>["repos"];
let sessionManager: ReturnType<typeof createServerContext>["sessions"];

beforeAll(async () => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-title-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;

	fixtureRepo = mkdtempSync(path.join(tmpdir(), "dilna-fixture-"));
	await git(["init", "-b", "main", fixtureRepo]);
	await git(["config", "user.email", "test@dilna.local"], { cwd: fixtureRepo });
	await git(["config", "user.name", "dilna test"], { cwd: fixtureRepo });
	writeFileSync(path.join(fixtureRepo, "README.md"), "# fixture\n");
	await git(["add", "."], { cwd: fixtureRepo });
	await git(["commit", "-m", "initial"], { cwd: fixtureRepo });

	({ repos: repoManager, sessions: sessionManager } = createServerContext());
});

afterAll(() => {
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(fixtureRepo, { recursive: true, force: true });
});

/** Run one turn and wait until the placeholder title has been replaced. */
async function runFirstTurnAndWaitForTitle(
	prompt: string,
): Promise<{ id: string; title: string }> {
	const repo = await repoManager.clone(
		fixtureRepo,
		`title-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
	);
	const session = await sessionManager.create(repo.id);
	const placeholder = `Session ${session.id.slice(0, 4)}`;
	expect(session.title).toBe(placeholder);

	sessionManager.beginTurn(session.id, prompt);
	await sessionManager.runTurn(session.id, prompt);

	// maybeDeriveTitle is fire-and-forget beside the turn — poll until the
	// placeholder is replaced (or fail loudly on timeout).
	const deadline = Date.now() + 2000;
	let done = await sessionManager.get(session.id);
	while (done!.title === placeholder && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 20));
		done = await sessionManager.get(session.id);
	}
	expect(done!.title).not.toBe(placeholder);
	await sessionManager.delete(session.id);
	await repoManager.delete(repo.id);
	return { id: session.id, title: done!.title };
}

describe("first-turn title derivation", () => {
	it("falls back to a prompt-derived title when the model call yields nothing", async () => {
		vi.mocked(generateSessionTitle).mockResolvedValue(null);
		const prompt = "please fix the login redirect bug";
		const { title } = await runFirstTurnAndWaitForTitle(prompt);
		expect(title).toBe(fallbackSessionTitle(prompt));
		expect(title).toContain("fix the login redirect");
	});

	it("prefers the model-derived title when the call succeeds", async () => {
		vi.mocked(generateSessionTitle).mockResolvedValue("Auth Redirect Fix");
		const { title } = await runFirstTurnAndWaitForTitle(
			"please fix the login redirect bug",
		);
		expect(title).toBe("Auth Redirect Fix");
	});
});
