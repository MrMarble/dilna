import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { usageEvents } from "../db/schema";
import type { SessionManager } from "../sessions/manager";
import { type EditFixture, isSuccessfulEdit } from "./editBenchFixture";
import { summarizeEditCalls } from "./editBenchMetrics";

/**
 * Runner for the edit-tool A/B harness (issue #138, item 1).
 *
 * Drives one fixed task (see `editBenchFixture.ts`) through a real Session and
 * reports what it cost. The harness exists to answer one question with
 * evidence instead of omp's README: does a line-anchored edit contract beat
 * `str_replace` on *our* model, on *our* task shape?
 *
 * Two halves, deliberately split:
 *
 * - `collectRunMetrics` is pure with respect to a (sessionId, db) pair and is
 *   what the tests pin — it reads only what dilna already persists.
 * - `runEditBenchmark` drives a live Session and needs an API key. It is thin
 *   on purpose: all the decisions worth getting right live in the pure half
 *   and in the fixture, so the expensive, nondeterministic part stays small.
 */

export type RunMetrics = {
	/** Output tokens the whole turn spent — the number the token claim is
	 * about. From `usage_events`, one row per turn. */
	outputTokens: number;
	inputTokens: number;
	/** Edit calls / failures / retries — see `summarizeEditCalls`. */
	edits: ReturnType<typeof summarizeEditCalls>;
	/** Whether the file ended up exactly as the task specified. */
	success: boolean;
};

/**
 * Read back what a finished turn cost. `usage_events` is one row per turn, so
 * a single-turn run has exactly one row; we sum anyway so a run that somehow
 * spanned turns reports the total rather than silently the first row.
 */
export function collectRunMetrics(
	sessionId: string,
	messages: Awaited<ReturnType<SessionManager["getMessages"]>>,
	actualText: string,
	fixture: EditFixture,
): RunMetrics {
	const rows = getDb()
		.select({
			inputTokens: usageEvents.inputTokens,
			outputTokens: usageEvents.outputTokens,
		})
		.from(usageEvents)
		.where(eq(usageEvents.sessionId, sessionId))
		.all();

	return {
		outputTokens: rows.reduce((sum, r) => sum + r.outputTokens, 0),
		inputTokens: rows.reduce((sum, r) => sum + r.inputTokens, 0),
		edits: summarizeEditCalls(messages),
		success: isSuccessfulEdit(actualText, fixture),
	};
}

export type BenchmarkRunOptions = {
	sessions: SessionManager;
	/** Repo id the Session is created against. */
	repoId: string;
	fixture: EditFixture;
	/** Absolute path of the worktree the Session edits, so the result can be
	 * read back off disk. */
	worktreePath: string;
};

export type BenchmarkRun = RunMetrics & {
	sessionId: string;
	/** Resulting file content, kept for diagnosing a failure. */
	actualText: string;
};

/**
 * Run the fixture task once, end to end, and report the cost.
 *
 * Mirrors the HTTP route's sequence (`routes/sessions.ts`): `create` →
 * `beginTurn` claims the turn slot and persists the user row, `runTurn` runs
 * it, and awaiting that promise is the turn-finished signal. `beginTurn` and
 * `runTurn` take the same text — the route passes it to both.
 */
export async function runEditBenchmark(
	options: BenchmarkRunOptions,
): Promise<BenchmarkRun> {
	const { sessions, repoId, fixture, worktreePath } = options;

	const session = await sessions.create(repoId);
	sessions.beginTurn(session.id, fixture.task);
	await sessions.runTurn(session.id, fixture.task);

	const messages = await sessions.getMessages(session.id);
	const actualText = readFileSync(
		`${worktreePath}/${fixture.relativePath}`,
		"utf8",
	);

	return {
		sessionId: session.id,
		actualText,
		...collectRunMetrics(session.id, messages, actualText, fixture),
	};
}

/** Whether the fixture's edit landed — checked against git rather than the
 * Session's own diff, so it's independent of how the edit tool reports. */
export function changedPaths(worktreePath: string): string[] {
	return execFileSync("git", ["status", "--porcelain"], {
		cwd: worktreePath,
		encoding: "utf8",
	})
		.split("\n")
		.map((line) => line.slice(3).trim())
		.filter(Boolean);
}
