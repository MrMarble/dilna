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

export function getDbPath(): string {
	return path.join(getDataDir(), "db", "dilna.sqlite");
}

/**
 * Where drizzle's migration folder lives, resolved relative to this file so it
 * works regardless of `process.cwd()` (dev via tsx from `apps/server`, prod
 * from `dist/`, tests via vitest root). Exported because the boot-time
 * migrator isn't the only thing that needs to find it — see
 * `sessions/legacy-upgrade.test.ts`, which drives a migration against a
 * pre-existing DB and would otherwise have to re-derive the path by depth.
 */
export function migrationsFolder(): string {
	return existsSync(path.join(__dirname, "..", "drizzle"))
		? path.join(__dirname, "..", "drizzle")
		: path.join(__dirname, "..", "..", "drizzle");
}

export function getDb() {
	if (_db) return _db;
	const dbPath = getDbPath();
	mkdirSync(path.dirname(dbPath), { recursive: true });
	_sqlite = new Database(dbPath);
	_sqlite.pragma("journal_mode = WAL");
	_db = drizzle(_sqlite, { schema });
	migrate(_db, { migrationsFolder: migrationsFolder() });
	return _db;
}

export function closeDb() {
	if (_sqlite) {
		_sqlite.close();
		_sqlite = null;
		_db = null;
	}
}
