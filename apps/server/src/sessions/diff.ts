import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ChangedFile, ChangedFileStatus } from "@dilna/shared";
import { logger } from "../logger";

const log = logger.child({ component: "sessions/diff" });

const execFileAsync = promisify(execFile);

async function git(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		maxBuffer: 50 * 1024 * 1024,
	});
	return stdout;
}

/**
 * Parse `git diff --numstat -M -z <ref>` output into per-path +/- counts,
 * keyed by the *new* path for renames.
 *
 * Non-rename records are `additions\tdeletions\tpath\0`. Rename records
 * split the path into three NUL-terminated fields — an empty one (in place
 * of the combined "old => new" the human-readable form would use), then the
 * old path, then the new path — so a record is a rename iff the field
 * immediately following the counts is empty.
 */
function parseNumstatZ(
	out: string,
): Map<string, { additions: number; deletions: number }> {
	const tokens = out.split("\0");
	// A trailing NUL produces one empty token at the end of the split; every
	// other empty token is a real (rename-marker) field, so only drop the
	// last one.
	if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();

	const result = new Map<string, { additions: number; deletions: number }>();
	let i = 0;
	while (i < tokens.length) {
		const head = tokens[i];
		if (head === undefined) break;
		const m = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(head);
		if (!m) {
			// Shouldn't happen with well-formed numstat output; skip the token
			// rather than looping forever.
			i++;
			continue;
		}
		const additions = m[1] === "-" ? 0 : Number(m[1]);
		const deletions = m[2] === "-" ? 0 : Number(m[2]);
		const inlinePath = m[3] ?? "";
		if (inlinePath !== "") {
			result.set(inlinePath, { additions, deletions });
			i += 1;
		} else {
			// Rename: old path, new path follow as separate tokens.
			const newPath = tokens[i + 2];
			if (newPath !== undefined) result.set(newPath, { additions, deletions });
			i += 3;
		}
	}
	return result;
}

type NameStatusEntry = { status: ChangedFileStatus; path: string };

/**
 * Parse `git diff --name-status -M -z <ref>` output into per-path statuses,
 * keyed by the *new* path for renames (which are normalized to "modified" —
 * the panel shows renames as a modification at their new location, not a
 * delete+add pair).
 */
function parseNameStatusZ(out: string): Map<string, NameStatusEntry> {
	const tokens = out.split("\0");
	if (tokens.length > 0 && tokens[tokens.length - 1] === "") tokens.pop();

	const result = new Map<string, NameStatusEntry>();
	let i = 0;
	while (i < tokens.length) {
		const code = tokens[i];
		if (code === undefined) break;
		if (code.startsWith("R") || code.startsWith("C")) {
			const newPath = tokens[i + 2];
			if (newPath !== undefined) {
				result.set(newPath, { status: "modified", path: newPath });
			}
			i += 3;
		} else {
			const filePath = tokens[i + 1];
			if (filePath !== undefined) {
				result.set(filePath, { status: mapStatusCode(code), path: filePath });
			}
			i += 2;
		}
	}
	return result;
}

function mapStatusCode(code: string): ChangedFileStatus {
	switch (code[0]) {
		case "A":
			return "added";
		case "D":
			return "deleted";
		default:
			// M (modified), T (type change), U (unmerged) and anything else
			// unrecognized all render as "modified".
			return "modified";
	}
}

/** Best-effort line count for a brand-new (untracked) file, mirroring what
 * `git numstat` would report if the file were staged. Binary files (detected
 * by a NUL byte in the first 8000 bytes, matching git's own heuristic) get 0
 * so they still show up in the panel without a misleading count. */
async function countNewFileLines(absPath: string): Promise<number> {
	let buf: Buffer;
	try {
		buf = await readFile(absPath);
	} catch {
		return 0;
	}
	const probeLen = Math.min(buf.length, 8000);
	for (let i = 0; i < probeLen; i++) {
		if (buf[i] === 0) return 0;
	}
	if (buf.length === 0) return 0;
	const text = buf.toString("utf8");
	const lines = text.split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines.length;
}

/**
 * Compute the Session's Worktree diff against the Repo's default-branch
 * merge-base, including uncommitted changes (staged, unstaged, and
 * untracked new files). Renamed files are normalized to a single "modified"
 * entry at the new path.
 *
 * Runs directly in the server process (not inside the agent subprocess's
 * sandbox), so it always has full read access to the worktree and its
 * shared git object store.
 */
export async function computeChangedFiles(
	worktreePath: string,
	defaultBranch: string,
): Promise<ChangedFile[]> {
	let mergeBase: string;
	try {
		mergeBase = (
			await git(["merge-base", defaultBranch, "HEAD"], worktreePath)
		).trim();
	} catch (err) {
		log.error(
			{ defaultBranch, worktreePath, err },
			"failed to find merge-base",
		);
		return [];
	}

	const [nameStatusOut, numstatOut, untrackedOut] = await Promise.all([
		git(["diff", "--name-status", "-M", "-z", mergeBase], worktreePath),
		git(["diff", "--numstat", "-M", "-z", mergeBase], worktreePath),
		git(["ls-files", "--others", "--exclude-standard", "-z"], worktreePath),
	]);

	const statuses = parseNameStatusZ(nameStatusOut);
	const stats = parseNumstatZ(numstatOut);

	const files: ChangedFile[] = [];
	for (const [filePath, entry] of statuses) {
		const s = stats.get(filePath);
		files.push({
			path: filePath,
			status: entry.status,
			additions: s?.additions ?? 0,
			deletions: s?.deletions ?? 0,
		});
	}

	const untracked = untrackedOut
		.split("\0")
		.filter((p) => p.length > 0)
		.filter((p) => !statuses.has(p));
	for (const filePath of untracked) {
		const additions = await countNewFileLines(
			path.join(worktreePath, filePath),
		);
		files.push({ path: filePath, status: "added", additions, deletions: 0 });
	}

	files.sort((a, b) => a.path.localeCompare(b.path));
	return files;
}
