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
		// Type-level suites (`*.test-d.ts`) assert the API client's response
		// envelopes against the shared types (ADR-0040). They never execute, so
		// they stay out of `include` above — a normal run would report them as
		// empty files. `pnpm --filter @dilna/web run test:types` runs them.
		typecheck: {
			include: ["src/**/*.test-d.ts"],
			tsconfig: "./tsconfig.json",
		},
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			// `@dilna/shared` resolves through the package's `exports` field, which
			// points at TypeScript source. Vite follows that, but a *subpath* import
			// (`@dilna/shared/testing`) needs the same mapping the tsconfigs declare
			// so the source is transformed rather than handed to Node raw.
			"@dilna/shared": path.resolve(__dirname, "../../packages/shared/src"),
		},
	},
});
