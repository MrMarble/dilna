import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServerContext } from "../container";
import { computeChangedFiles } from "./diff";

const execFileAsync = promisify(execFile);
const git = (args: string[], opts?: { cwd?: string }) =>
	execFileAsync("git", args, { ...opts, maxBuffer: 50 * 1024 * 1024 });

// SessionView (the wire shape) doesn't carry the internal worktreePath or
// branchName — both derive from the id, the way SessionManager lays them out.
const wt = (repo: { slug: string }, id: string) =>
	path.join(dataDir, "worktrees", repo.slug, id);
const branchOf = (id: string) => `dilna/${id}`;

/**
 * Sessions on an empty Repo — a remote with zero commits (e.g. a freshly
 * created GitHub repository) cloned through `RepoManager.clone`. Its default
 * branch is an unborn HEAD symref, so `git worktree add -b <branch> <path>
 * <base>` fails with "fatal: invalid reference: main" and, before the orphan
 * fallback in createWorktree, Session creation 500'd with no visible feedback
 * (the sidebar button just flickered back).
 */

let dataDir: string;
let emptyRemote: string;
let oldDataDir: string | undefined;
let oldTmpdir: string | undefined;
let repoManager: ReturnType<typeof createServerContext>["repos"];
let sessionManager: ReturnType<typeof createServerContext>["sessions"];

beforeAll(async () => {
	// Sandbox quirk: /tmp is read-only here, so point os.tmpdir() at the
	// worktree before any manager creates its scratch state.
	oldTmpdir = process.env.TMPDIR;
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-empty-repo-"));
	process.env.TMPDIR = dataDir;
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;

	// An empty bare remote — `git init --bare` with no commit on any branch,
	// exactly what GitHub hands back for a brand-new repository.
	emptyRemote = path.join(dataDir, "empty-remote.git");
	await git(["init", "--bare", "--initial-branch=main", "--", emptyRemote]);

	({ repos: repoManager, sessions: sessionManager } = createServerContext());
});

afterAll(() => {
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	if (oldTmpdir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = oldTmpdir;
	rmSync(dataDir, { recursive: true, force: true });
});

describe("SessionManager.create on an empty repo", () => {
	it("clones the empty remote and resolves an unborn default branch", async () => {
		const repo = await repoManager.clone(emptyRemote);
		expect(repo.defaultBranch).toBe("main");
		// Unborn: the branch symref exists but no commit backs it yet.
		await expect(
			git(
				[
					"rev-parse",
					"--verify",
					"--quiet",
					`refs/heads/${repo.defaultBranch}`,
				],
				{
					cwd: repo.path,
				},
			),
		).rejects.toThrow();
	});

	it("creates a Session whose Worktree sits on an unborn session branch", async () => {
		const repo = await repoManager.clone(emptyRemote);
		const session = await sessionManager.create(repo.id);

		expect(existsSync(wt(repo, session.id))).toBe(true);
		const { stdout: head } = await git(["symbolic-ref", "HEAD"], {
			cwd: wt(repo, session.id),
		});
		expect(head.trim()).toBe(`refs/heads/${branchOf(session.id)}`);
		// Unborn branch: status works and reports no commits yet.
		const { stdout: status } = await git(["status", "-b", "--porcelain"], {
			cwd: wt(repo, session.id),
		});
		expect(status).toContain("No commits yet");
		// Registered as a real linked worktree of the bare Repo.
		const { stdout: list } = await git(["worktree", "list", "--porcelain"], {
			cwd: repo.path,
		});
		expect(list).toContain(wt(repo, session.id));
		expect(list).not.toContain("prunable");
	});

	it("can commit into the orphan Worktree, creating the branch root", async () => {
		const repo = await repoManager.clone(emptyRemote);
		const session = await sessionManager.create(repo.id);

		writeFileSync(path.join(wt(repo, session.id), "README.md"), "# hi\n");
		await git(["add", "."], { cwd: wt(repo, session.id) });
		await git(
			["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "first"],
			{ cwd: wt(repo, session.id) },
		);
		const { stdout: branches } = await git(
			["branch", "--list", branchOf(session.id)],
			{
				cwd: repo.path,
			},
		);
		expect(branches).toContain(branchOf(session.id));
		const { stdout: log } = await git(["log", "--oneline"], {
			cwd: wt(repo, session.id),
		});
		expect(log).toContain("first");
	});

	it("supports a second parallel Session on the same empty Repo", async () => {
		const repo = await repoManager.clone(emptyRemote);
		const a = await sessionManager.create(repo.id);
		const b = await sessionManager.create(repo.id);
		expect(wt(repo, a.id)).not.toBe(wt(repo, b.id));
		const { stdout: list } = await git(["worktree", "list", "--porcelain"], {
			cwd: repo.path,
		});
		expect(list).toContain(wt(repo, a.id));
		expect(list).toContain(wt(repo, b.id));
	});

	it("deletes the orphan-Worktree Session cleanly", async () => {
		const repo = await repoManager.clone(emptyRemote);
		const session = await sessionManager.create(repo.id);
		await sessionManager.delete(session.id);
		expect(existsSync(wt(repo, session.id))).toBe(false);
		const { stdout: list } = await git(["worktree", "list", "--porcelain"], {
			cwd: repo.path,
		});
		expect(list).not.toContain(wt(repo, session.id));
	});

	it("deletes an orphan-Worktree Session that already committed", async () => {
		const repo = await repoManager.clone(emptyRemote);
		const session = await sessionManager.create(repo.id);
		writeFileSync(path.join(wt(repo, session.id), "f.txt"), "x\n");
		await git(["add", "."], { cwd: wt(repo, session.id) });
		await git(
			["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "root"],
			{ cwd: wt(repo, session.id) },
		);
		await sessionManager.delete(session.id);
		expect(existsSync(wt(repo, session.id))).toBe(false);
		// Branch deleted with the Session, even though it carries the only
		// root commit of the repo so far.
		const { stdout: branches } = await git(
			["branch", "--list", branchOf(session.id)],
			{
				cwd: repo.path,
			},
		);
		expect(branches).not.toContain(branchOf(session.id));
	});
});

describe("computeChangedFiles on an empty repo", () => {
	it("reports the first commit's files as all-added against the empty tree", async () => {
		const repo = await repoManager.clone(emptyRemote);
		const session = await sessionManager.create(repo.id);
		const worktreePath = wt(repo, session.id);

		// No commits yet: nothing changed, and nothing should crash.
		expect(await computeChangedFiles(worktreePath, repo.defaultBranch)).toEqual(
			[],
		);

		writeFileSync(path.join(worktreePath, "README.md"), "# hi\n");
		mkdirSync(path.join(worktreePath, "src"), { recursive: true });
		writeFileSync(path.join(worktreePath, "src", "a.ts"), "export {};\n");
		await git(["add", "."], { cwd: worktreePath });
		await git(
			["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "first"],
			{ cwd: worktreePath },
		);

		const files = await computeChangedFiles(worktreePath, repo.defaultBranch);
		// .codegraph/ artifacts from initCodegraph legitimately show up too —
		// assert on the files this test created.
		const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
		expect(byPath["README.md"]).toMatchObject({ status: "added" });
		expect(byPath["src/a.ts"]).toMatchObject({ status: "added" });
	});
});
