import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createServerContext } from "../container";
import { createEditFixture } from "./editBenchFixture";
import { runEditBenchmark } from "./editBenchRunner";

/**
 * The paid, manual arm of the edit-tool A/B harness (issue #138, item 1).
 *
 * **Never run this in CI.** It needs a real provider API key and spends real
 * money on every run. It is written as a test file only because `tsx` cannot
 * execute in this container (its IPC pipe needs a writable `/tmp`), so vitest
 * is the one available TypeScript runner.
 *
 * Opt in explicitly:
 *
 *   EDIT_BENCH_RUNS=5 vitest run apps/server/src/agents/editBench.live.test.ts
 *
 * Skipped by default so an ordinary `pnpm test` never touches the network.
 * Which provider/model it uses comes from `DILNA_PROVIDER`/`DILNA_MODEL` (env
 * wins, since the harness points `DILNA_DATA_DIR` at a scratch dir with no
 * `llm_config` override row) — i.e. whatever the running instance is
 * configured with.
 */

const RUNS = Number(process.env.EDIT_BENCH_RUNS ?? "0");
const LABEL =
	process.env.EDIT_BENCH_LABEL ?? process.env.DILNA_MODEL ?? "stock";

describe.runIf(RUNS > 0)("edit-tool benchmark (live, spends tokens)", () => {
	it(`runs the fixture task ${RUNS}x and reports the distribution`, async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "dilna-edit-bench-"));
		process.env.DILNA_DATA_DIR = dataDir;
		const cleanup: string[] = [dataDir];

		const results: {
			outputTokens: number;
			inputTokens: number;
			attempts: number;
			failures: number;
			retries: number;
			success: boolean;
		}[] = [];

		try {
			for (let i = 0; i < RUNS; i++) {
				const fixture = createEditFixture();
				cleanup.push(fixture.repoDir);

				// Per run, so the db handle resolves after DILNA_DATA_DIR is set
				// (issue #150).
				const { repos, sessions } = createServerContext({ dataDir });
				const repo = await repos.clone(fixture.repoDir, `bench-${i}`);
				const session = await sessions.create(repo.id);
				const unsubscribe = sessions.subscribe(session.id, (ev) => {
					console.log(
						`[diag] event: ${ev.type} ${JSON.stringify(ev).slice(0, 200)}`,
					);
				});
				const worktreePath = join(dataDir, "worktrees", repo.slug, session.id);

				const run = await runEditBenchmark({
					sessions,
					repoId: repo.id,
					fixture,
					worktreePath,
				});
				const after = await sessions.get(session.id);
				unsubscribe();
				const msgs = await sessions.getMessages(session.id);
				console.log(
					`[diag] status=${after?.status} provider=${after?.provider} model=${after?.model} ` +
						`rows=${msgs.length} parts=${JSON.stringify(
							msgs.map((m) => ({
								role: m.role,
								parts: m.parts.map((p) =>
									p.type === "tool_call"
										? `tool:${p.tool}`
										: p.type === "text"
											? `text:${p.text.slice(0, 60)}`
											: p.type,
								),
							})),
						)}`,
				);
				results.push({
					outputTokens: run.outputTokens,
					inputTokens: run.inputTokens,
					attempts: run.edits.attempts,
					failures: run.edits.failures,
					retries: run.edits.retries,
					success: run.success,
				});
				console.log(
					`[${LABEL}] run ${i + 1}/${RUNS}: ${run.outputTokens} out tokens, ` +
						`${run.edits.attempts} edits, ${run.edits.retries} retries, ` +
						`${run.success ? "ok" : "FAILED"}`,
				);
			}
		} finally {
			for (const dir of cleanup) rmSync(dir, { recursive: true, force: true });
		}

		const tokens = results.map((r) => r.outputTokens).sort((a, b) => a - b);
		const median = tokens[Math.floor(tokens.length / 2)] ?? 0;
		console.log(
			`\n[${LABEL}] median output tokens: ${median} ` +
				`(min ${tokens[0]}, max ${tokens[tokens.length - 1]})\n` +
				`[${LABEL}] success: ${results.filter((r) => r.success).length}/${RUNS}, ` +
				`total retries: ${results.reduce((s, r) => s + r.retries, 0)}, ` +
				`total failures: ${results.reduce((s, r) => s + r.failures, 0)}\n` +
				`[${LABEL}] raw: ${JSON.stringify(results)}`,
		);

		expect(results).toHaveLength(RUNS);
	}, 600_000);
});
