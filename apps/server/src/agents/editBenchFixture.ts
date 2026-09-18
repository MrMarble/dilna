import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The fixed task the edit-tool A/B harness runs (issue #138, item 1).
 *
 * The harness compares two edit-tool contracts; everything except the tool has
 * to be held constant. This module builds that constant: a throwaway git repo
 * holding one file, a prompt asking for a specific change, and the exact text
 * the file must contain for the run to count as a success.
 *
 * Three properties matter and are pinned by the tests beside this file:
 *
 * - **Success is decidable without judgment.** `expectedText` is compared
 *   against the file after the turn; no rubric, no model-as-judge. That is
 *   what makes the harness reproducible rather than a vibe.
 * - **The fixture is committed.** A Session's Worktree is a `git worktree add`
 *   off the repo's HEAD, so anything left uncommitted simply isn't there.
 * - **The file is big enough to make addressing cost differ.** With a handful
 *   of lines, quoting the old text and naming a line number are both cheap and
 *   the A/B measures nothing.
 *
 * The prompt deliberately names the *change*, not the tool: both arms get the
 * same words, and only the tool surface behind them differs.
 */

export type EditFixture = {
	/** Throwaway git repo the Session is created against. */
	repoDir: string;
	/** Absolute path of the file under edit, inside `repoDir`. */
	filePath: string;
	/** Repo-relative path — what the agent sees and what `path` args carry. */
	relativePath: string;
	/** Committed starting content. */
	initialText: string;
	/** What `filePath` must contain for the run to count as a success. */
	expectedText: string;
	/** The user message both arms are run with. */
	task: string;
};

/** Relative path of the file under edit, from the repo root. */
const TARGET_RELATIVE_PATH = "src/config.ts";

/** How many filler lines to generate. Chosen so the file is comfortably past
 * the point where quoting a whole region is a meaningful token cost, while
 * staying small enough to keep runs cheap. */
const FILLER_LINES = 80;

/** The two constants the task asks the model to rename, planted far enough
 * apart that a single edit call can't do both with one contiguous quote — but
 * few enough that both fit in one call's `edits[]` array. */
const RENAMES: ReadonlyArray<readonly [from: string, to: string]> = [
	["DEFAULT_TIMEOUT_SECONDS", "REQUEST_TIMEOUT_SECONDS"],
	["MAX_RETRY_ATTEMPTS", "RETRY_BUDGET"],
];

/** Build the initial file: two decoy constants the task does *not* touch, the
 * two it does, plus filler. The decoys matter: they give the model plausible
 * near-misses, which is what makes a text-matching edit tool work for its
 * living, and they are what a wrong `oldText` would accidentally match. */
function buildInitialText(): string {
	const lines: string[] = [
		"// Fixture for the dilna edit-tool benchmark (issue #138).",
		"// Filler below exists so line addressing is cheaper than quoting text.",
		"",
		"export const DEFAULT_TIMEOUT_SECONDS = 30;",
		"export const MAX_RETRY_ATTEMPTS = 3;",
		"",
	];
	// Decoys: same shape, names the task does not ask about. A careless edit
	// that anchors on the value rather than the name can hit these instead.
	lines.push("export const DEFAULT_POLL_INTERVAL_MS = 30;");
	lines.push("export const MAX_RETRY_BACKOFF_MS = 3;");
	lines.push("");
	for (let i = 0; i < FILLER_LINES; i++) {
		lines.push(`export function helper${i}(value: number): number {`);
		lines.push(`\treturn value + ${i};`);
		lines.push("}");
		lines.push("");
	}
	return lines.join("\n");
}

/** What the file must look like afterwards: the same text with the two names
 * swapped. Derived from `initialText` by the same substitution the task asks
 * for, so the two can't drift apart when the fixture changes. */
function buildExpectedText(initialText: string): string {
	return RENAMES.reduce(
		(text, [from, to]) => text.split(from).join(to),
		initialText,
	);
}

function buildTask(): string {
	const changes = RENAMES.map(([from, to]) => `\`${from}\` → \`${to}\``).join(
		" and ",
	);
	return `In \`${TARGET_RELATIVE_PATH}\`, rename ${changes}. Change the declarations only — do not touch anything else in the file.`;
}

/** Create the fixture repo. Caller owns cleanup of `repoDir`. */
export function createEditFixture(): EditFixture {
	const repoDir = mkdtempSync(join(tmpdir(), "dilna-edit-bench-"));
	const relativePath = TARGET_RELATIVE_PATH;
	const filePath = join(repoDir, relativePath);
	const initialText = buildInitialText();

	// `src/` doesn't exist yet; writeFileSync won't create it.
	execFileSync("mkdir", ["-p", join(repoDir, "src")]);
	writeFileSync(filePath, initialText);

	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
	git("init", "--quiet", "--initial-branch=main");
	git("config", "user.email", "bench@dilna.test");
	git("config", "user.name", "dilna edit benchmark");
	git("add", "-A");
	git("commit", "--quiet", "-m", "fixture: initial state");

	return {
		repoDir,
		filePath,
		relativePath,
		initialText,
		expectedText: buildExpectedText(initialText),
		task: buildTask(),
	};
}

/** Whether a run's resulting file content counts as a success. Trimmed
 * comparison: trailing-newline churn isn't what the A/B is measuring, and a
 * model that reformats the tail shouldn't be scored as a failed edit. */
export function isSuccessfulEdit(
	actualText: string,
	fixture: EditFixture,
): boolean {
	return actualText.trim() === fixture.expectedText.trim();
}
