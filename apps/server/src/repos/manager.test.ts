import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoManager } from "./manager";

const execFileAsync = promisify(execFile);
const git = (args: string[], opts?: { cwd?: string }) =>
	execFileAsync("git", args, { ...opts, maxBuffer: 50 * 1024 * 1024 });

let dataDir: string;
let fixtureRepo: string;
let oldDataDir: string | undefined;

beforeAll(async () => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-repo-"));
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

describe("RepoManager", () => {
	it("clones a bare repo and detects the default branch", async () => {
		const repo = await repoManager.clone(fixtureRepo);
		expect(repo.slug).toBeTruthy();
		expect(repo.defaultBranch).toBe("main");
		expect(repo.remoteUrl).toBe(fixtureRepo);
		expect(existsSync(repo.path)).toBe(true);
		// bare repo: no working tree
		expect(existsSync(path.join(repo.path, "README.md"))).toBe(false);
		// but HEAD pointer is configured
		const { stdout } = await git(["symbolic-ref", "HEAD"], {
			cwd: repo.path,
		});
		expect(stdout.trim()).toBe("refs/heads/main");

		// list now contains the repo
		const repos = await repoManager.list();
		expect(repos.find((r) => r.id === repo.id)).toBeTruthy();
	});

	it("derives a unique slug when a slug collides", async () => {
		const first = await repoManager.clone(fixtureRepo, "dupe");
		const second = await repoManager.clone(fixtureRepo, "dupe");
		expect(first.slug).toBe("dupe");
		expect(second.slug).toBe("dupe-2");

		await repoManager.delete(first.id);
		await repoManager.delete(second.id);
	});

	it("deletes a repo and removes the bare clone from disk", async () => {
		const repo = await repoManager.clone(fixtureRepo, `del-${Date.now()}`);
		const repoPath = repo.path;
		expect(existsSync(repoPath)).toBe(true);

		await repoManager.delete(repo.id);

		expect(existsSync(repoPath)).toBe(false);
		const repos = await repoManager.list();
		expect(repos.find((r) => r.id === repo.id)).toBeUndefined();
	});
});
