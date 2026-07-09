import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeChangedFiles } from "./diff";

const execFileAsync = promisify(execFile);
const git = (args: string[], cwd: string) =>
	execFileAsync("git", args, { cwd, maxBuffer: 50 * 1024 * 1024 });

let repoDir: string;

beforeEach(async () => {
	repoDir = mkdtempSync(path.join(tmpdir(), "dilna-diff-test-"));
	await git(["init", "-b", "main", repoDir], repoDir);
	await git(["config", "user.email", "test@dilna.local"], repoDir);
	await git(["config", "user.name", "dilna test"], repoDir);
	writeFileSync(path.join(repoDir, "keep.txt"), "line1\nline2\nline3\n");
	writeFileSync(path.join(repoDir, "todelete.txt"), "bye\n");
	writeFileSync(path.join(repoDir, "tomove.txt"), "r1\nr2\nr3\n");
	await git(["add", "."], repoDir);
	await git(["commit", "-m", "initial"], repoDir);
});

afterEach(() => {
	rmSync(repoDir, { recursive: true, force: true });
});

describe("computeChangedFiles", () => {
	it("returns no files when the worktree matches the merge-base", async () => {
		const files = await computeChangedFiles(repoDir, "main");
		expect(files).toEqual([]);
	});

	it("reports a tracked modification", async () => {
		writeFileSync(
			path.join(repoDir, "keep.txt"),
			"line1\nline2\nline3\nline4\n",
		);
		const files = await computeChangedFiles(repoDir, "main");
		expect(files).toEqual([
			{ path: "keep.txt", status: "modified", additions: 1, deletions: 0 },
		]);
	});

	it("reports a staged deletion", async () => {
		await git(["rm", "-q", "todelete.txt"], repoDir);
		const files = await computeChangedFiles(repoDir, "main");
		expect(files).toEqual([
			{ path: "todelete.txt", status: "deleted", additions: 0, deletions: 1 },
		]);
	});

	it("reports a staged (git add) new file as added", async () => {
		writeFileSync(path.join(repoDir, "staged-new.txt"), "a\nb\n");
		await git(["add", "staged-new.txt"], repoDir);
		const files = await computeChangedFiles(repoDir, "main");
		expect(files).toEqual([
			{ path: "staged-new.txt", status: "added", additions: 2, deletions: 0 },
		]);
	});

	it("reports an untracked new file as added, including uncommitted changes", async () => {
		writeFileSync(path.join(repoDir, "untracked.txt"), "x\ny\nz\n");
		const files = await computeChangedFiles(repoDir, "main");
		expect(files).toEqual([
			{ path: "untracked.txt", status: "added", additions: 3, deletions: 0 },
		]);
	});

	it("normalizes a rename to a single 'modified' entry at the new path", async () => {
		await git(["mv", "tomove.txt", "moved.txt"], repoDir);
		writeFileSync(path.join(repoDir, "moved.txt"), "r1\nr2\nr3\nr4\n");
		const files = await computeChangedFiles(repoDir, "main");
		expect(files).toEqual([
			{ path: "moved.txt", status: "modified", additions: 1, deletions: 0 },
		]);
	});

	it("combines multiple simultaneous changes and sorts by path", async () => {
		writeFileSync(
			path.join(repoDir, "keep.txt"),
			"line1\nline2\nline3\nline4\n",
		);
		writeFileSync(path.join(repoDir, "untracked.txt"), "new\n");
		await git(["rm", "-q", "todelete.txt"], repoDir);
		await git(["mv", "tomove.txt", "moved.txt"], repoDir);

		const files = await computeChangedFiles(repoDir, "main");
		expect(files.map((f) => f.path)).toEqual([
			"keep.txt",
			"moved.txt",
			"todelete.txt",
			"untracked.txt",
		]);
		const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
		expect(byPath["keep.txt"]?.status).toBe("modified");
		expect(byPath["moved.txt"]?.status).toBe("modified");
		expect(byPath["todelete.txt"]?.status).toBe("deleted");
		expect(byPath["untracked.txt"]?.status).toBe("added");
	});

	it("returns no files for a nonexistent default branch instead of throwing", async () => {
		const files = await computeChangedFiles(repoDir, "does-not-exist");
		expect(files).toEqual([]);
	});
});
