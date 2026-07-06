import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
	type BetterSQLite3Database,
	drizzle,
} from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

let _db: BetterSQLite3Database<typeof schema> | null = null;
let _sqlite: Database.Database | null = null;

export function getDataDir(): string {
	return (
		process.env.DILNA_DATA_DIR ??
		path.resolve(process.env.HOME ?? ".", ".dilna/server-data")
	);
}

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
	migrate(_db, { migrationsFolder: "./drizzle" });
	return _db;
}

export function closeDb() {
	if (_sqlite) {
		_sqlite.close();
		_sqlite = null;
		_db = null;
	}
}
