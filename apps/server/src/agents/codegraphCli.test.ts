import { describe, expect, it } from "vitest";
import { createCodegraphTool, verifyCodegraphSurface } from "./codegraphTool";

/**
 * `codegraphTool` drives a binary this repo does not ship: the Dockerfile
 * pins `@colbymchenry/codegraph@1.6.0` and the tool shells out to its
 * `explore` subcommand. A pinned dependency is a promise the CLI keeps its
 * shape, and upstream ships roughly a release a week — so this file is the
 * thing that turns "the pin drifted" into a red build instead of a silent
 * degradation.
 *
 * **Why this is not just a unit test.** The failure mode being guarded is
 * invisible: if a flag is renamed or `explore` is dropped, `execFile` throws,
 * `execute()` returns "codegraph could not answer that … use grep/read
 * instead", and every Session quietly falls back to grep with nothing in the
 * logs a human looks at. The tool never claims to work; it just stops being
 * used. So the assertion has to be against the *real* binary's contract.
 *
 * **Runs only where the binary exists.** It is present in the runtime image
 * (where this is the meaningful check) and in dilna's own dev container, and
 * absent on a bare `pnpm test` on a laptop or in CI — see
 * {@link verifyCodegraphSurface} for why a missing binary reports
 * "unavailable" and is skipped here rather than failing. The build-time half
 * of this guard lives in the Dockerfile's `codegraph --version` check; this
 * is the run-time half.
 */
const probe = await verifyCodegraphSurface();

/**
 * Narrowed by a real `if` rather than via `describe.skipIf(probe.available)`
 * alone: the union discriminates on `available`, and TypeScript cannot see
 * that `skipIf`'s argument implies the same narrowing inside the suite body
 * (the repo also forbids non-null assertions, so an `s = surface!` escape
 * hatch isn't available). Registering the suite only in the branch where the
 * probe succeeded keeps the narrowing honest *and* skips the tests wherever
 * codegraph isn't installed.
 */
if (probe.available) {
	const surface = probe;

	describe("codegraph CLI surface", () => {
		it("is the version ADR-0044 was written against", () => {
			// Deliberately an equality, not a range: bumping the pin is a
			// deliberate act (re-run the smoke check, skim upstream's changelog
			// for `explore` changes), and this is where that act is recorded.
			expect(surface.version).toBe("1.6.0");
		});

		it("still has `explore`, with the options the tool passes", () => {
			// The tool invokes exactly this shape:
			//   codegraph explore <query> --no-color --path <dir> [--max-files N]
			// `--no-color` is declared on the *top-level* command, not on
			// `explore` (its `--help` does not list it — commander passes the
			// flag through regardless, confirmed against 1.6.0), so it is
			// asserted against the root help while the subcommand options are
			// asserted against `explore`'s own.
			expect(surface.exploreHelp).toContain("--max-files");
			expect(surface.exploreHelp).toContain("--path");
			expect(surface.rootHelp).toContain("--no-color");
		});

		it("accepts the exact argument shape the tool builds", () => {
			// The assertion that would actually have caught a rename: run the
			// command `createCodegraphTool` builds, against a real directory,
			// and require it to parse rather than be rejected as an unknown
			// option. `--help` text can stay honest while the parser changes
			// under it; only invoking it proves the shape.
			expect(surface.probeAccepted).toBe(true);
		});

		it("still reports a missing index with the marker the tool keys on", () => {
			// `isMissingIndex` matches this sentence, and it is the *only* thing
			// distinguishing "this project isn't indexed" (routine — return
			// guidance) from "codegraph is broken" (a real error). If upstream
			// rewords it, an unindexed Session starts reporting a malfunction
			// instead. Probed from a directory known to have no `.codegraph/`,
			// because a Worktree that has one would answer successfully.
			expect(surface.missingIndexMarker).toBe(true);
		});
	});
} else {
	// Not a failure: the binary only exists in the runtime image and in
	// dilna's own dev container. Reported as a skip so a run that *should*
	// have exercised this (the `codegraph-surface` CI job, which installs
	// the pinned version) can tell a genuine pass from a silent no-op —
	// hence the reason string naming why.
	describe.skip("codegraph CLI surface (codegraph not installed)", () => {
		it("is exercised only where the binary exists", () => {
			expect(probe.reason).toMatch(/codegraph/i);
		});
	});
}

describe("verifyCodegraphSurface without the binary", () => {
	it("reports unavailable rather than throwing when exec fails", async () => {
		// The seam exists so this file can assert the skip path from a
		// machine that *does* have the binary: point it at a name that
		// cannot resolve.
		const absent = await verifyCodegraphSurface("definitely-not-codegraph");
		expect(absent.available).toBe(false);
		if (absent.available) return;
		expect(absent.reason).toMatch(/not|missing|ENOENT|command/i);
	});
});

describe("createCodegraphTool", () => {
	it("names itself codegraph and takes a query", () => {
		const tool = createCodegraphTool("/tmp/whatever");
		expect(tool.name).toBe("codegraph");
		// The description is the only place the Agent learns the playbook
		// upstream ships in its MCP `initialize` response (pi-agent-core has
		// no MCP client — ADR-0044), so its key instructions are pinned
		// here: they are the load-bearing part of the change, not prose.
		expect(tool.description).toMatch(/instead of a grep\/read loop/i);
		expect(tool.description).toMatch(/already read/i);
	});
});
