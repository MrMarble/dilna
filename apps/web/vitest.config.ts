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
		include: ["src/**/*.test.tsx"],
		setupFiles: ["./src/test/setup.ts"],
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
		},
	},
});
