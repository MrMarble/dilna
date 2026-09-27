/**
 * Trim-savings measurement over a real tool-heavy Session (issue #272).
 *
 * Boots an isolated dilna instance against the fake provider
 * (`scripts/cache-spy.mjs`), drives three real turns whose tool calls read
 * sizeable files (including one re-read of the same file), then measures
 * the *seeded context bytes* both ways on the exact same persisted history:
 *
 * - **before (verbatim)** — what dilna seeds today: every tool output in
 *   full. This is the baseline the policy is measured against.
 * - **after (policy)** — the same walk with the shared `ToolOutputPolicy`
 *   applied (identical result-set dedup for the re-read, head/tail trim for
 *   first reads), imported straight from `packages/shared` so the numbers
 *   come from the exact code the seeder runs.
 *
 * The persisted rows are only read, never written — the measurement is a
 * query over real history, matching the policy's own invariants.
 *
 * Usage (from the repo root, after `pnpm --filter @dilna/server build`):
 *
 *     node scripts/measure-trim-savings.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import fs, { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const serverDist = path.join(repoRoot, "apps/server/dist/index.js");
const scratch = mkdtempSync(path.join(repoRoot, ".trim-measure-"));
const dataDir = path.join(scratch, "data");
const port = 3478;
const baseUrl = `http://127.0.0.1:${port}`;
fs.mkdirSync(dataDir, { recursive: true });

const require_ = createRequire(path.join(repoRoot, "apps/server/package.json"));
const Database = require_("better-sqlite3");

const { applyToolOutputPolicy } = await import(
	`${repoRoot}/packages/shared/src/toolOutputPolicy.ts`
);
const { createHash } = await import("node:crypto");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- fixture: two sizeable files -------------------------------------------

const workRepo = path.join(scratch, "fixture");
execFileSync("git", ["init", "-b", "main", workRepo]);
execFileSync("git", ["config", "user.email", "measure@dilna.local"], {
	cwd: workRepo,
});
execFileSync("git", ["config", "user.name", "measure"], { cwd: workRepo });
const bigFile = (tag) =>
	Array.from(
		{ length: 300 },
		(_, i) => `line ${i}: ${tag} ${"content ".repeat(6)}`,
	).join("\n");
fs.writeFileSync(path.join(workRepo, "big.txt"), bigFile("BIG"));
fs.writeFileSync(path.join(workRepo, "other.txt"), bigFile("OTHER"));
execFileSync("git", ["add", "."], { cwd: workRepo });
execFileSync("git", ["commit", "-m", "fixture"], { cwd: workRepo });
const bareRepo = path.join(scratch, "fixture.git");
execFileSync("git", ["clone", "--bare", workRepo, bareRepo]);

// ---- server lifecycle --------------------------------------------------------

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
			if ((await fetch(`${baseUrl}/api/health`)).ok) return;
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

// ---- turns: read big, read other, re-read big --------------------------------

const turns = [
	'@@tool:read:{"path":"big.txt"}',
	'@@tool:read:{"path":"other.txt"}',
	'@@tool:read:{"path":"big.txt"}',
];

let turnSeq = 0;
async function runTurn(sessionId, marker) {
	turnSeq += 1;
	await api("POST", `/sessions/${sessionId}/messages`, {
		text: `Turn ${turnSeq}: ${marker}`,
	});
	const deadline = Date.now() + 120_000;
	for (;;) {
		const { session } = await api("GET", `/sessions/${sessionId}`);
		if (session.status === "idle") return;
		if (session.status === "crashed")
			throw new Error(`turn ${turnSeq}: crashed`);
		if (Date.now() > deadline) throw new Error(`turn ${turnSeq}: timeout`);
		await sleep(400);
	}
}

// ---- measurement --------------------------------------------------------------

function partTextLengths(parts) {
	let total = 0;
	for (const part of parts) {
		if (part.type === "text") total += part.text.length;
		else if (part.type === "tool_call") {
			total += JSON.stringify(part.input ?? {}).length;
			total += typeof part.output === "string" ? part.output.length : 0;
		}
	}
	return total;
}

try {
	await startServer();
	const { repo } = await api("POST", "/repos", { url: bareRepo });
	const { session } = await api("POST", "/sessions", { repoId: repo.id });
	for (const marker of turns) await runTurn(session.id, marker);
	await stopServer();

	const db = new Database(path.join(dataDir, "db", "dilna.sqlite"), {
		readonly: true,
	});
	const rows = db
		.prepare(
			"SELECT role, parts_json FROM messages WHERE session_id = ? ORDER BY seq",
		)
		.all(session.id);
	db.close();

	const history = rows.map((r) => ({
		role: r.role,
		parts: JSON.parse(r.parts_json),
	}));

	// BEFORE: verbatim seeding (main's behavior) — every tool output in full.
	let before = 0;
	for (const m of history) before += partTextLengths(m.parts);

	// AFTER: the same walk with the shared policy — identical code to what
	// buildInitialMessages' seed path runs.
	let after = 0;
	const seen = new Map();
	let turnCount = 0;
	for (const m of history) {
		if (m.role === "user") {
			turnCount += 1;
			after += partTextLengths(m.parts);
			continue;
		}
		let changed = 0;
		const parts = m.parts.map((part) => {
			if (part.type !== "tool_call") return part;
			const output = typeof part.output === "string" ? part.output : "";
			if (output.length === 0) return part;
			const trimmed = applyToolOutputPolicy(
				part.tool,
				part.input,
				output,
				sha256,
				{ turnLabel: `turn ${turnCount}`, seen },
			);
			if (!trimmed) return part;
			changed += 1;
			return { ...part, output: trimmed.seeded };
		});
		after += changed > 0 ? partTextLengths(parts) : partTextLengths(m.parts);
	}

	console.log(
		`\n=== Trim savings over a real tool-heavy Session (${turnSeq} turns, 3 reads) ===`,
	);
	console.log(`seeded context bytes, verbatim (before): ${before}`);
	console.log(`seeded context bytes, with policy (after): ${after}`);
	console.log(
		`saved: ${before - after} bytes (${(((before - after) / before) * 100).toFixed(1)}% of the seeded context)`,
	);
	console.log("(scratch cleaned up)\n");
	fs.rmSync(scratch, { recursive: true, force: true });
	process.exit(0);
} catch (err) {
	console.error(err);
	await stopServer();
	process.exit(1);
}
