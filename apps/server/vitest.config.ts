import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "server",
		environment: "node",
		root: __dirname,
		include: ["src/**/*.test.ts"],
		testTimeout: 30_000,
	},
	resolve: {
		// `@dilna/shared` resolves through the package's `exports` field (see
		// packages/shared/package.json) — every subpath it declares has to be
		// mapped here too, so vitest transforms the TypeScript source rather than
		// handing it to Node untransformed.
		alias: {
			"@dilna/shared": path.resolve(__dirname, "../../packages/shared/src"),
		},
	},
});
