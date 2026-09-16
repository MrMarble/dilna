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
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const here = import.meta.dirname;
const serverEntry = path.resolve(here, "../../server/dist/index.js");
const webDist = path.resolve(here, "../dist");
const port = process.env.PORT ?? "4311";

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
