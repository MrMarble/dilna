import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { is } from "drizzle-orm";
import { getTableConfig, SQLiteTable } from "drizzle-orm/sqlite-core";
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
	onTestFinished,
} from "vitest";
import { closeDb, getDb, getDbPath } from ".";
import * as schema from "./schema";

/**
 * Guards the one workflow `CLAUDE.md` prescribes for schema changes: edit
 * `schema.ts`, run `db:generate`, commit what it writes.
 *
 * That workflow silently broke for a dozen migrations. `drizzle/meta` stopped
 * getting snapshots after 0016, every later migration (0017–0029) was
 * hand-written to route around the resulting junk diff, and each one widened
 * the gap. Nothing failed, because the runtime only reads the SQL and the
 * journal — a missing snapshot is invisible until the next person runs
 * `db:generate` and gets `CREATE TABLE` for tables that already exist.
 *
 * Two checks, each catching one way the three sources of truth (`schema.ts`,
 * the snapshot chain, the migration SQL) drift apart:
 *
 * - **the snapshot is current**: `db:generate` against a copy of `drizzle/`
 *   produces nothing. Fails when a migration lands without its snapshot.
 * - **the migrations build the schema**: a fresh DB migrated from scratch has
 *   exactly the columns and indexes `schema.ts` declares. Fails when
 *   hand-written SQL disagrees with the schema it claims to implement.
 */

const serverRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

describe("drizzle migrations", () => {
	it("have a snapshot matching schema.ts, so db:generate starts from reality", () => {
		const scratch = mkdtempSync(path.join(tmpdir(), "dilna-drizzle-gen-"));
		try {
			cpSync(path.join(serverRoot, "drizzle"), path.join(scratch, "drizzle"), {
				recursive: true,
			});
			const before = readdirSync(path.join(scratch, "drizzle"));
			// Run from the scratch dir with a relative `--out`: drizzle-kit
			// prefixes `./` to whatever it's given, so an absolute path breaks.
			execFileSync(
				path.join(serverRoot, "node_modules/.bin/drizzle-kit"),
				[
					"generate",
					"--dialect",
					"sqlite",
					"--schema",
					path.join(serverRoot, "src/db/schema.ts"),
					"--out",
					"./drizzle",
				],
				{ cwd: scratch, stdio: "pipe" },
			);
			const generated = readdirSync(path.join(scratch, "drizzle")).filter(
				(f) => !before.includes(f),
			);
			expect(
				generated,
				"schema.ts differs from the latest drizzle/meta snapshot — run `pnpm --filter @dilna/server run db:generate` and commit both the SQL and the snapshot",
			).toEqual([]);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	}, 60_000);

	describe("applied from scratch", () => {
		let dataDir: string;
		let oldDataDir: string | undefined;

		beforeAll(() => {
			dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-migrations-"));
			oldDataDir = process.env.DILNA_DATA_DIR;
			process.env.DILNA_DATA_DIR = dataDir;
		});

		afterAll(() => {
			closeDb();
			if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
			else process.env.DILNA_DATA_DIR = oldDataDir;
			rmSync(dataDir, { recursive: true, force: true });
		});

		const tables = (Object.values(schema) as unknown[])
			.filter((v): v is SQLiteTable => is(v, SQLiteTable))
			.map((t) => getTableConfig(t));

		it.each(
			tables.map((t) => [t.name, t] as const),
		)("build %s as schema.ts declares it", (_name, table) => {
			// `getDb()` runs every migration on first open; read the result
			// through a second, read-only handle.
			getDb();
			const db = new Database(getDbPath(), { readonly: true });
			onTestFinished(() => {
				db.close();
			});

			// Column order is deliberately ignored: `ALTER TABLE ADD` appends, so
			// a migrated table legitimately orders columns differently from a
			// freshly created one.
			const actualColumns = (
				db.pragma(`table_info('${table.name}')`) as {
					name: string;
					notnull: number;
				}[]
			)
				.map((c) => `${c.name}${c.notnull ? " not null" : ""}`)
				.sort();
			const declaredColumns = table.columns
				.map((c) => `${c.name}${c.notNull ? " not null" : ""}`)
				.sort();
			expect(actualColumns).toEqual(declaredColumns);

			// Named indexes only — SQLite's own `sqlite_autoindex_*` back the
			// primary keys and unique constraints the column check already covers.
			const actualIndexes = (
				db.pragma(`index_list('${table.name}')`) as { name: string }[]
			)
				.map((i) => i.name)
				.filter((n) => !n.startsWith("sqlite_autoindex_"))
				.sort();
			const declaredIndexes = [
				...table.indexes.map((i) => i.config.name),
				...table.columns
					.filter((c) => c.isUnique)
					.map((c) => c.uniqueName ?? `${table.name}_${c.name}_unique`),
			].sort();
			expect(actualIndexes).toEqual(declaredIndexes);
		});
	});
});
