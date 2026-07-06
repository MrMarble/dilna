import { existsSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "drizzle-kit";

function findWorkspaceRoot(start: string): string {
	let dir = start;
	while (true) {
		if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return start;
		dir = parent;
	}
}

function resolveDbPath(): string {
	const raw = process.env.DILNA_DB_PATH;
	if (raw && path.isAbsolute(raw)) return raw;
	const dataDir =
		raw ??
		(() => {
			const env = process.env.DILNA_DATA_DIR;
			if (!env) return ".dilna/server-data";
			if (path.isAbsolute(env)) return env;
			return path.resolve(findWorkspaceRoot(process.cwd()), env);
		})();
	return path.join(dataDir, "db", "dilna.sqlite");
}

export default defineConfig({
	schema: "./src/db/schema.ts",
	out: "./drizzle",
	dialect: "sqlite",
	dbCredentials: {
		url: resolveDbPath(),
	},
	verbose: true,
	strict: true,
});
