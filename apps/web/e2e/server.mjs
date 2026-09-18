#!/usr/bin/env node
// Boots an isolated dilna instance for the e2e suite: a scratch SQLite DB and
// the built SPA served by the server itself, so one process gives a real API
// and a real UI with no Vite in the loop.
//
// Two things this deliberately guards against:
//
//  1. `DILNA_DATA_DIR` defaults to `./data`, which is the developer's REAL
//     local state (cloned repos, worktrees, db). An e2e run must never touch
//     it, so we always point at a fresh mkdtemp directory.
//  2. `mise.toml`'s `[env]` block sets `DILNA_DATA_DIR=./data` and `PORT=3001`,
//     and the `node` on PATH is a mise shim that applies those OVER inherited
//     env. Playwright's `webServer.env` would therefore be silently ignored.
//     `process.execPath` is the real binary (this script is already running
//     under it), which is why the child is spawned with that and not "node".
//
// Two instances start per run (see playwright.config.ts's `webServer` array):
//
//   * **empty** (default) — the fixture `shell.spec.ts` and `clone-repo.spec.ts`
//     assert against. Those specs are regression canaries for the zero state,
//     so they need an instance with genuinely nothing cloned.
//   * **seeded** (`--seed`) — one repo cloned from a local bare remote and one
//     Session created, for `loaded-state.spec.ts` (issue #238).
//
// They are separate processes with separate data dirs on purpose. Seeding the
// empty instance in place (or having one spec delete the seed) would mean the
// zero-state canaries and the loaded-state specs fighting over one DB — which
// is the shared-state hazard `workers: 1` already exists to avoid.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedInstance } from "./fixtures/seed.mjs";

const seed = process.argv.includes("--seed");

const here = import.meta.dirname;
const serverEntry = path.resolve(here, "../../server/dist/index.js");
const webDist = path.resolve(here, "../dist");
const port = process.env.PORT ?? (seed ? "4312" : "4311");

for (const [label, target] of [
	["server build", serverEntry],
	["web build", path.join(webDist, "index.html")],
]) {
	if (!existsSync(target)) {
		console.error(
			`e2e: missing ${label} at ${target}\n` +
				`Run \`pnpm build\` at the repo root first.`,
		);
		process.exit(1);
	}
}

const dataDir = mkdtempSync(path.join(tmpdir(), "dilna-e2e-"));

const child = spawn(process.execPath, [serverEntry], {
	stdio: "inherit",
	env: {
		...process.env,
		PORT: port,
		DILNA_DATA_DIR: dataDir,
		DILNA_WEB_DIST: webDist,
		// Keep the suite hermetic: no outbound pushes from a test run.
		DILNA_DISABLE_WEB_PUSH: "1",
	},
});

const cleanup = () => {
	try {
		rmSync(dataDir, { recursive: true, force: true });
	} catch {
		// Best effort — a leftover temp dir is not worth failing a run over.
	}
};

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		child.kill(signal);
		cleanup();
		process.exit(0);
	});
}

child.on("exit", (code) => {
	cleanup();
	process.exit(code ?? 0);
});

/**
 * Wait for the server to answer `/api/health` (the same probe Playwright's
 * `webServer.url` uses), then seed if this instance asked for it.
 *
 * The ordering matters: Playwright starts the specs as soon as that URL
 * responds, so anything that must be true of every test on this instance — the
 * seeded repo and Session — has to be in place before this process is
 * observable as up. Seeding after the probe would let a spec race the fixture.
 */
async function seedWhenReady() {
	const baseUrl = `http://localhost:${port}`;
	const deadline = Date.now() + 60_000;
	for (;;) {
		try {
			const res = await fetch(`${baseUrl}/api/health`);
			if (res.ok) break;
		} catch {
			// Not listening yet.
		}
		if (Date.now() > deadline) {
			console.error("e2e: server did not become healthy in 60s");
			child.kill("SIGTERM");
			process.exit(1);
		}
		await new Promise((r) => setTimeout(r, 200));
	}

	if (!seed) return;

	try {
		const { repo, session } = await seedInstance({ baseUrl, baseDir: dataDir });
		console.error(
			`e2e: seeded repo ${repo.slug} (${repo.id}) with session ${session.id}`,
		);
	} catch (err) {
		console.error("e2e: seeding failed", err);
		child.kill("SIGTERM");
		process.exit(1);
	}
}

// Deliberately not awaited at top level: the process must stay alive to
// supervise the child, and the child's exit handler above is what ends the
// run. An unhandled rejection would otherwise crash the supervisor and leave
// the server orphaned.
void seedWhenReady();
