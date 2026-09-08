import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { loadBuildInfo } from "./build-info";

const { appVersion, commitHash, commitDate } = loadBuildInfo();

export default defineConfig({
	plugins: [react()],
	define: {
		__APP_VERSION__: JSON.stringify(appVersion),
		__COMMIT_HASH__: JSON.stringify(commitHash),
		__COMMIT_DATE__: JSON.stringify(commitDate),
	},
	test: {
		name: "web",
		environment: "happy-dom",
		// Both extensions: plain-.ts suites (lib/rate-limits, lib/tool-meta,
		// lib/routes) are real tests too, and a .tsx-only glob silently skipped
		// them rather than failing loudly.
		include: ["src/**/*.test.{ts,tsx}"],
		setupFiles: ["./src/test/setup.ts"],
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
});
