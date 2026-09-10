import {
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, migrationsFolder } from "../db";

// Proves an EXISTING instance's DB (one already migrated to 0020, with real
// rows) upgrades in place when the new code opens it: the added column is
// nullable, so pre-migration rows survive and simply read back ungrouped.
let dataDir: string;
let old: string | undefined;

beforeAll(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-legacy-"));
	old = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;
});

afterAll(() => {
	closeDb();
	if (old === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = old;
	rmSync(dataDir, { recursive: true, force: true });
});

describe("existing DB upgrading past 0021_message_turn_id", () => {
	it("keeps pre-migration rows and reads them back with no turnId", () => {
		// 1. Build a "before" migrations folder: exactly what an old instance
		//    shipped — 0020's journal entry, no 0021 file.
		// Start from the real, current migrations folder, then remove the one
		// under test — the same folder the server itself migrates from, resolved
		// the same way (no depth-based path guessing).
		const legacyMigrations = path.join(dataDir, "legacy-drizzle");
		cpSync(migrationsFolder(), legacyMigrations, { recursive: true });
		rmSync(path.join(legacyMigrations, "0021_message_turn_id.sql"));
		const journalPath = path.join(legacyMigrations, "meta/_journal.json");
		const journal = JSON.parse(readFileSync(journalPath, "utf8"));
		journal.entries = journal.entries.filter(
			(e: { tag: string }) => e.tag !== "0021_message_turn_id",
		);
		writeFileSync(journalPath, JSON.stringify(journal, null, 1));

		// 2. Open a DB at that version and put a row in it, the way a running
		//    old instance would have.
		const dbPath = path.join(dataDir, "legacy.sqlite");
		const sqlite = new Database(dbPath);
		sqlite.pragma("journal_mode = WAL");
		migrate(drizzle(sqlite), { migrationsFolder: legacyMigrations });
		sqlite
			.prepare(
				"INSERT INTO messages (id, session_id, role, parts_json, created_at) VALUES (?,?,?,?,?)",
			)
			.run(
				"legacy-1",
				"s1",
				"assistant",
				JSON.stringify([{ type: "text", text: "pre-migration row" }]),
				5,
			);
		const colsBefore = sqlite
			.prepare("PRAGMA table_info(messages)")
			.all()
			.map((c) => (c as { name: string }).name);
		expect(colsBefore).not.toContain("turn_id");
		sqlite.close();

		// 3. Now run the migration under test against that same DB, as booting
		//    the new server would.
		const upgraded = new Database(dbPath);
		upgraded.pragma("journal_mode = WAL");
		migrate(drizzle(upgraded), { migrationsFolder: migrationsFolder() });
		upgraded.close();

		// 4. The old row is still there, and its turn_id is NULL — which
		//    `foldTurnRows` treats as "never grouped", so a legacy session
		//    renders exactly as it did before.
		const check = new Database(dbPath, { readonly: true });
		const row = check
			.prepare("SELECT id, turn_id FROM messages WHERE id = ?")
			.get("legacy-1") as { id: string; turn_id: string | null };
		check.close();
		expect(row.id).toBe("legacy-1");
		expect(row.turn_id).toBeNull();
	});
});
