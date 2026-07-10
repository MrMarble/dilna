import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
	type BetterSQLite3Database,
	drizzle,
} from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let _db: BetterSQLite3Database<typeof schema> | null = null;
let _sqlite: Database.Database | null = null;

function findWorkspaceRoot(start: string): string {
	let dir = start;
	while (true) {
		if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return start;
		dir = parent;
	}
}

function resolveDataDir(): string {
	const raw = process.env.DILNA_DATA_DIR;
	if (!raw) return path.resolve(process.env.HOME ?? ".", ".dilna/server-data");
	if (path.isAbsolute(raw)) return raw;
	const root = findWorkspaceRoot(process.cwd());
	return path.resolve(root, raw);
}

export function getDataDir(): string {
	return resolveDataDir();
}

// Claude Code's own session/config storage (`~/.claude` by default: its
// transcripts, resumable-session index, etc. — see claude.ts's
// CLAUDE_SCRATCH_WRITABLE_PATHS) must live inside dilna's own persistent
// volume, not under $HOME. In the reference Docker/Kubernetes deployment
// only DILNA_DATA_DIR is a mounted volume (ADR-0009); anything under $HOME
// is wiped on every pod restart while dilna's own SQLite rows (which
// persist `agentSessionId` — see SessionManager.ensureStarted) still point
// at a now-nonexistent transcript, producing "No conversation found with
// session ID: ..." forever after. Set here, at this module's load time
// rather than in index.ts, because every other module that needs this
// (claude.ts, via its `../db` import) transitively imports this file
// first, guaranteeing the env var is set before anything reads it. `??=`
// respects an operator who's already set CLAUDE_CONFIG_DIR explicitly
// (host-passthrough per ADR-0005/0009).
process.env.CLAUDE_CONFIG_DIR ??= path.join(getDataDir(), "claude-home");

export function getDbPath(): string {
	return path.join(getDataDir(), "db", "dilna.sqlite");
}

export function getDb() {
	if (_db) return _db;
	const dbPath = getDbPath();
	mkdirSync(path.dirname(dbPath), { recursive: true });
	_sqlite = new Database(dbPath);
	_sqlite.pragma("journal_mode = WAL");
	_db = drizzle(_sqlite, { schema });
	// Drizzle migrations live next to the compiled source: <server>/drizzle.
	// Resolve relative to this file so it works regardless of process.cwd()
	// (dev via tsx from apps/server, prod from dist/, tests via vitest root).
	const migrationsFolder = existsSync(path.join(__dirname, "..", "drizzle"))
		? path.join(__dirname, "..", "drizzle")
		: path.join(__dirname, "..", "..", "drizzle");
	migrate(_db, { migrationsFolder });
	return _db;
}

export function closeDb() {
	if (_sqlite) {
		_sqlite.close();
		_sqlite = null;
		_db = null;
	}
}
