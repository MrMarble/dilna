import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "server",
		environment: "node",
		root: __dirname,
		include: ["src/**/*.test.ts"],
		testTimeout: 30_000,
	},
});
