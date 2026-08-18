import { defineConfig } from "@playwright/test";

// ponytail: no webServer block — dilna needs an isolated server+web pair
// (see CLAUDE.md), so point baseURL at whatever instance you already have running.
export default defineConfig({
	testDir: "./e2e",
	use: {
		baseURL: process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:5174",
	},
});
