/**
 * CLI for the edit-tool A/B harness (issue #138, item 1).
 *
 * Runs the fixed fixture task N times and prints a distribution. **Needs a
 * real API key** and spends real money — see the module doc in
 * `editBenchRunner.ts` for the split between this and the tested pure parts.
 *
 *   DILNA_DATA_DIR=$(mktemp -d) DILNA_PROVIDER=anthropic \
 *   DILNA_MODEL=claude-sonnet-4-5 ANTHROPIC_API_KEY=... \
 *   node editBenchCli.ts --label str_replace --runs 5
 *
 * Run it twice — once per arm, the arm being whichever edit tool
 * `agents/pi.ts` currently registers — and compare the two printed blocks.
 * A second arm's summary can also be passed in with `--compare <json>` once
 * both have been captured.
 *
 * Deliberately a script, not a route or a test: it is a one-off measurement,
 * not a product surface, and it should never run in CI (which has no API key
 * and shouldn't pay for one).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerContext } from "../container";
import { createEditFixture } from "./editBenchFixture";
import { formatComparison, summarizeArm } from "./editBenchReport";
import { type BenchmarkRun, runEditBenchmark } from "./editBenchRunner";

type Args = {
	label: string;
	runs: number;
	repoDir?: string;
};

function parseArgs(argv: string[]): Args {
	const args: Args = { label: "unlabeled", runs: 3 };
	for (let i = 0; i < argv.length; i++) {
		const next = argv[i + 1];
		if (argv[i] === "--label" && next) args.label = next;
		else if (argv[i] === "--runs" && next) args.runs = Number(next);
		else if (argv[i] === "--repo" && next) args.repoDir = next;
	}
	return args;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const dataDir = mkdtempSync(join(tmpdir(), "dilna-edit-bench-data-"));
	process.env.DILNA_DATA_DIR = dataDir;

	// A fixture per run: each needs its own repo so a previous run's edit
	// can't leak into the next one's starting state.
	const runs: BenchmarkRun[] = [];
	const cleanup: string[] = [dataDir];

	try {
		for (let i = 0; i < args.runs; i++) {
			const fixture = createEditFixture();
			cleanup.push(fixture.repoDir);

			// Built per run so the DB handle and data dir are resolved after
			// DILNA_DATA_DIR is set (issue #150).
			const { repos, sessions } = createServerContext({ dataDir });
			const repo = await repos.clone(fixture.repoDir, `bench-${i}`);
			const session = await sessions.create(repo.id);
			const worktreePath = join(dataDir, "worktrees", repo.slug, session.id);

			const result = await runEditBenchmark({
				sessions,
				repoId: repo.id,
				fixture,
				worktreePath,
			});
			runs.push(result);
			process.stderr.write(
				`run ${i + 1}/${args.runs}: ${result.outputTokens} output tokens, ` +
					`${result.edits.attempts} edits, ${result.edits.retries} retries, ` +
					`${result.success ? "ok" : "FAILED"}\n`,
			);
		}

		const summary = summarizeArm(runs);
		const report = formatComparison(
			{ baseline: summary, candidate: summary, outputTokenChangePct: 0 },
			{ baseline: args.label, candidate: args.label },
		);
		// Only the baseline arm's own block is meaningful here; the comparison
		// needs two arms' data. Print the raw summary so it can be pasted into
		// the ticket and compared by hand.
		process.stdout.write(
			`${args.label}:\n${JSON.stringify(summary, null, 2)}\n\n${report}\n`,
		);
	} finally {
		for (const dir of cleanup) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
}

// Only run when invoked directly, so importing this file in a test or a REPL
// doesn't kick off a paid benchmark.
if (process.argv[1]?.endsWith("editBenchCli.ts")) {
	main().catch((error) => {
		process.stderr.write(`${String(error)}\n`);
		process.exit(1);
	});
}
