import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoManager } from "../repos/manager";
import { sessionManager } from "./manager";

const execFileAsync = promisify(execFile);
const git = (args: string[], opts?: { cwd?: string }) =>
	execFileAsync("git", args, { ...opts, maxBuffer: 50 * 1024 * 1024 });

let dataDir: string;
let fixtureRepo: string;
let oldDataDir: string | undefined;

beforeAll(async () => {
	// Redirect dilna data dir to a temp directory.
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;

	// Build a tiny fixture git repo we can clone from.
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

describe("SessionManager", () => {
	it("creates a session backed by a real git worktree", async () => {
		const repo = await repoManager.clone(fixtureRepo);
		expect(repo.defaultBranch).toBe("main");

		const session = await sessionManager.create(repo.id);
		expect(session.status).toBe("idle");
		expect(session.title).toBe("New session");

		// Worktree on disk
		const worktreePath = path.join(dataDir, "worktrees", repo.slug, session.id);
		expect(existsSync(worktreePath)).toBe(true);
		expect(existsSync(path.join(worktreePath, "README.md"))).toBe(true);

		// git worktree list shows it under the dilna/<id> branch
		const { stdout } = await git(["worktree", "list"], { cwd: repo.path });
		expect(stdout).toContain(`dilna/${session.id}`);

		// listByRepo returns the session
		const sessions = await sessionManager.listByRepo(repo.id);
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.id).toBe(session.id);

		// getView hides internal fields
		const view = await sessionManager.getView(session.id);
		expect(view).not.toBeNull();
		expect(view).not.toHaveProperty("worktreePath");
		expect(view).not.toHaveProperty("branchName");
		expect(view).not.toHaveProperty("agentSessionId");
	});

	it("deletes a session and removes its worktree + branch", async () => {
		const repo = await repoManager.clone(fixtureRepo, `clone-${Date.now()}`);
		const session = await sessionManager.create(repo.id);
		const worktreePath = path.join(dataDir, "worktrees", repo.slug, session.id);
		expect(existsSync(worktreePath)).toBe(true);

		await sessionManager.delete(session.id);

		expect(existsSync(worktreePath)).toBe(false);
		expect(await sessionManager.get(session.id)).toBeNull();

		// branch is gone too
		const { stdout } = await git(["branch", "--list"], { cwd: repo.path });
		expect(stdout).not.toContain(`dilna/${session.id}`);

		// worktree list doesn't show the path
		const { stdout: wtList } = await git(["worktree", "list"], {
			cwd: repo.path,
		});
		expect(wtList).not.toContain(worktreePath);
	});

	it("resetAllToIdle flips working sessions back to idle", async () => {
		const repo = await repoManager.clone(fixtureRepo, `reset-${Date.now()}`);
		const session = await sessionManager.create(repo.id);

		await sessionManager.setStatus(session.id, "working");
		let updated = await sessionManager.get(session.id);
		expect(updated?.status).toBe("working");

		await sessionManager.resetAllToIdle();
		updated = await sessionManager.get(session.id);
		expect(updated?.status).toBe("idle");

		await sessionManager.delete(session.id);
		await repoManager.delete(repo.id);
	});
});
