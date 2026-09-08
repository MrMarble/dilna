import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		name: "shared",
		environment: "node",
		root: __dirname,
		include: ["src/**/*.test.ts"],
	},
});
