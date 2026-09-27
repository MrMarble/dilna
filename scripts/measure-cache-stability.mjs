/**
 * Cache-stability measurement over a real multi-turn Session (issue #271).
 *
 * Boots an isolated dilna instance against the cache-simulating fake
 * provider (`scripts/cache-spy.cjs`), drives three real turns with a real
 * tool call and a server restart between each (the cold-start path), and
 * prints the per-turn cache split the provider reported — from dilna's own
 * `usage_events`, i.e. what the Metrics page and the context card see.
 *
 * Between restarts the script installs + enables one Repo skill (the
 * current prompt is rebuilt from `formatSkillsPrompt(repoSkills)` at every
 * spawn, so a skill enabled mid-session changes the prompt at the next cold
 * start). Run it on the pre-freeze code and again after the prompt freeze;
 * the before/after tables are the baseline pair ADR-0048's sibling
 * requirement asks for. A healthy run reads `read ≈ total` on every turn
 * after the first; instability shows as `write ≈ total` repeating.
 *
 * Usage (from the repo root, after `pnpm --filter @dilna/server build`):
 *
 *     node scripts/measure-cache-stability.mjs [--label "before freeze"]
 *
 * Everything runs under a scratch data dir; the process cleans up after
 * itself unless it crashes (keep the dir then — the sqlite db is the
 * evidence).
 */
import { execFileSync, spawn } from "node:child_process";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const args = process.argv.slice(2);
const labelIdx = args.indexOf("--label");
const LABEL = labelIdx >= 0 ? args[labelIdx + 1] : "unlabelled run";

const repoRoot = path.resolve(import.meta.dirname, "..");
const serverDist = path.join(repoRoot, "apps/server/dist/index.js");
const scratch = mkdtempSync(path.join(repoRoot, ".cache-measure-"));
const require_ = createRequire(path.join(repoRoot, "apps/server/package.json"));
const Database = require_("better-sqlite3");
const dataDir = path.join(scratch, "data");
const port = 3477;
const baseUrl = `http://127.0.0.1:${port}`;
mkdirSync(dataDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Fixture repo: one file worth reading with a tool ---------------------

const workRepo = path.join(scratch, "fixture");
execFileSync("git", ["init", "-b", "main", workRepo]);
execFileSync("git", ["config", "user.email", "measure@dilna.local"], {
	cwd: workRepo,
});
execFileSync("git", ["config", "user.name", "measure"], { cwd: workRepo });
writeFileSync(
	path.join(workRepo, "big.txt"),
	Array.from({ length: 400 }, (_, i) => `line ${i}: ${"x".repeat(90)}`).join(
		"\n",
	),
);
execFileSync("git", ["add", "."], { cwd: workRepo });
execFileSync("git", ["commit", "-m", "fixture"], { cwd: workRepo });
const bareRepo = path.join(scratch, "fixture.git");
execFileSync("git", ["clone", "--bare", workRepo, bareRepo]);

// ---- Server lifecycle -------------------------------------------------------

let server;
async function startServer() {
	server = spawn(process.execPath, [serverDist], {
		env: {
			...process.env,
			PORT: String(port),
			DILNA_DATA_DIR: dataDir,
			DILNA_PROVIDER: "anthropic",
			DILNA_MODEL: "claude-opus-5",
			ANTHROPIC_API_KEY: "sk-ant-measure-fake",
			DILNA_CONTAINERIZED: "true",
			NODE_OPTIONS: `--import file://${path.join(repoRoot, "scripts/cache-spy.mjs")}`,
			CACHE_SPY_STATE: path.join(dataDir, "cache-spy-state.json"),
			CACHE_SPY_DEBUG: "1",
			CACHE_SPY_DEBUG_FILE: path.join(scratch, "spy-debug.log"),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	server.stdout.on("data", (d) =>
		fs.appendFileSync(path.join(scratch, "server.log"), d),
	);
	server.stderr.on("data", (d) =>
		fs.appendFileSync(path.join(scratch, "server.log"), d),
	);
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${baseUrl}/api/health`);
			if (res.ok) return;
		} catch {
			// not up yet
		}
		await sleep(200);
	}
	throw new Error("server did not become healthy");
}

async function stopServer() {
	if (!server) return;
	const child = server;
	server = undefined;
	await new Promise((resolve) => {
		child.once("exit", resolve);
		child.kill("SIGTERM");
		setTimeout(() => {
			child.kill("SIGKILL");
			resolve();
		}, 5000);
	});
}

async function api(method, path_, body) {
	const res = await fetch(`${baseUrl}/api${path_}`, {
		method,
		headers: body === undefined ? {} : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`${method} ${path_} → ${res.status}`);
	return res.json();
}

// ---- The drift source: a Repo skill enabled mid-session --------------------
// Mirrors what `installSkill` + `setSkillEnabled` write (files + rows), so
// the next cold start rebuilds the prompt with one more skills line.

let skillSeq = 0;
function enableOneMoreSkill() {
	skillSeq += 1;
	const id = `measure/fixture-skill-${skillSeq}`;
	const dir = path.join(
		dataDir,
		"skills",
		"measure",
		`fixture-skill-${skillSeq}`,
	);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		path.join(dir, "SKILL.md"),
		`---\nname: fixture-skill-${skillSeq}\ndescription: A fixture skill enabled mid-measurement to change the rebuilt prompt.\n---\n\nFixture body ${skillSeq}.\n`,
	);
	const db = new Database(path.join(dataDir, "db", "dilna.sqlite"));
	db.prepare(
		"INSERT INTO skills (id, source, slug, name, description, source_url, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, strftime('%s','now'), strftime('%s','now'))",
	).run(
		id,
		"measure",
		`fixture-skill-${skillSeq}`,
		`Fixture skill ${skillSeq}`,
		"A fixture skill enabled mid-measurement to change the rebuilt prompt.",
		"https://example.com/fixture",
	);
	db.prepare(
		"INSERT INTO repo_skills (skill_id, repo_id, enabled_at) VALUES (?, ?, strftime('%s','now'))",
	).run(id, globalThis.__repoId);
	db.close();
}

// ---- Turn driver ------------------------------------------------------------

let turnSeq = 0;
async function runTurn(sessionId) {
	turnSeq += 1;
	await api("POST", `/sessions/${sessionId}/messages`, {
		text: `Turn ${turnSeq}: inspect the fixture. @@tool:read:{"path":"big.txt"}`,
	});
	// Tap the SSE stream so a failure surfaces with its actual detail.
	const controller = new AbortController();
	const sseDone = fetch(`${baseUrl}/api/sessions/${sessionId}/stream`, {
		signal: controller.signal,
	})
		.then(async (res) => {
			const reader = res.body.getReader();
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				const chunk = new TextDecoder().decode(value);
				if (process.env.CACHE_SSE_DEBUG)
					console.error(`[sse] ${chunk.replaceAll("\n", " ").slice(0, 300)}`);
				if (chunk.includes("turn_failed"))
					console.error(`[sse-fail] ${chunk.slice(0, 500)}`);
			}
		})
		.catch(() => undefined);
	const deadline = Date.now() + 120_000;
	try {
		for (;;) {
			const { session } = await api("GET", `/sessions/${sessionId}`);
			if (session.status === "idle") return;
			if (session.status === "crashed")
				throw new Error(`turn ${turnSeq}: session crashed`);
			if (Date.now() > deadline) throw new Error(`turn ${turnSeq}: timeout`);
			await sleep(500);
		}
	} finally {
		controller.abort();
		await sseDone;
	}
}

// ---- Main --------------------------------------------------------------------

try {
	await startServer();
	const { repo } = await api("POST", "/repos", { url: bareRepo });
	globalThis.__repoId = repo.id;
	const { session } = await api("POST", "/sessions", { repoId: repo.id });

	for (let turn = 1; turn <= 3; turn++) {
		if (turn > 1) {
			// Cold start with a genuinely changed prompt: kill the process (the
			// provider's cache outlives it — the spy's state file persists),
			// enable one more skill, respawn.
			await stopServer();
			enableOneMoreSkill();
			await startServer();
		}
		await runTurn(session.id);
	}
	await stopServer();

	// The evidence, straight from dilna's own accounting.
	const db = new Database(path.join(dataDir, "db", "dilna.sqlite"), {
		readonly: true,
	});
	const rows = db
		.prepare(
			`SELECT created_at, input_tokens, cache_read_tokens, cache_write_tokens,
			        provider_context_tokens, estimated_context_tokens
			   FROM usage_events WHERE session_id = ? AND purpose = 'turn'
			  ORDER BY created_at, rowid`,
		)
		.all(session.id);
	db.close();

	console.log(`\n=== Cache stability — ${LABEL} ===`);
	console.log(
		"turn | read    | write   | total(prompt) | share of prompt re-paid",
	);
	let consecutiveWrites = 0;
	for (const [i, r] of rows.entries()) {
		const total = r.cache_read_tokens + r.cache_write_tokens;
		const repaid =
			total > 0 ? Math.round((r.cache_write_tokens / total) * 100) : 0;
		consecutiveWrites =
			r.cache_write_tokens > r.cache_read_tokens ? consecutiveWrites + 1 : 0;
		console.log(
			`${String(i + 1).padEnd(4)} | ${String(r.cache_read_tokens).padEnd(7)} | ${String(r.cache_write_tokens).padEnd(7)} | ${String(total).padEnd(13)} | ${repaid}%`,
		);
	}
	const warn = consecutiveWrites >= 2;
	console.log(
		`\nconsecutive write-dominant turns at the end: ${consecutiveWrites}`,
	);
	console.log(
		`context-card cache-instability warning: ${warn ? "FIRES" : "absent"}`,
	);
	console.log(`(scratch kept at ${scratch} on crash only)\n`);
	if (!process.argv.includes("--keep"))
		rmSync(scratch, { recursive: true, force: true });
	process.exit(0);
} catch (err) {
	console.error(err);
	await stopServer();
	process.exit(1);
}
