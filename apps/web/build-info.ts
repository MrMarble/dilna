import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function git(args: string[]): string {
	try {
		return execFileSync("git", args).toString().trim();
	} catch {
		return "unknown";
	}
}

/** Version + commit info baked in at build/dev-server-start time via each
 * Vite/Vitest config's `define`, and read back through the globals declared
 * in src/env.d.ts (see AppVersion.tsx). `version` tracks the root
 * package.json's `version`, kept in sync with the git tag at release time —
 * either one is meant to be the source of truth. */
export function loadBuildInfo() {
	const root = git(["rev-parse", "--show-toplevel"]);
	const pkgPath =
		root === "unknown" ? undefined : path.join(root, "package.json");
	const version =
		pkgPath && fs.existsSync(pkgPath)
			? (JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { version: string })
					.version
			: "0.0.0";

	return {
		appVersion: version,
		commitHash: git(["rev-parse", "--short", "HEAD"]),
		commitDate: git(["log", "-1", "--format=%cI"]),
	};
}
