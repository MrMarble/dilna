import { defineConfig, devices } from "@playwright/test";

/**
 * E2E regression suite.
 *
 * Unit tests mock the API; these run the real server against a real (scratch)
 * SQLite DB with the real built SPA, which is the only place wiring bugs
 * between the parts actually show up.
 *
 * `PLAYWRIGHT_BASE_URL` points the run at an instance you already have going
 * and skips the managed server — useful for iterating against `pnpm dev`.
 */

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4311);
const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = externalBaseUrl ?? `http://localhost:${port}`;

export default defineConfig({
	testDir: "./e2e",
	// Fail the run if a `test.only` is committed.
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	// The suite shares one server process and one DB, so specs must not race
	// each other's state. Revisit only alongside per-worker isolation.
	workers: 1,
	fullyParallel: false,
	reporter: process.env.CI
		? [["github"], ["html", { open: "never" }]]
		: [["list"]],
	use: {
		baseURL,
		// Artefacts only for failures — keeps a green run cheap.
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
	},
	projects: [
		{
			name: "chromium",
			// Desktop viewport: the sidebar is only rendered above the md
			// breakpoint (768px), so a smaller viewport would hide most of
			// the navigation behind a drawer.
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: externalBaseUrl
		? undefined
		: {
				command: "node e2e/server.mjs",
				// `url` (not `port`): waits for a real 200 from the API, so the
				// suite can't start against a socket that's open but not serving.
				url: `http://localhost:${port}/api/repos`,
				reuseExistingServer: !process.env.CI,
				timeout: 60_000,
				stdout: "pipe",
				stderr: "pipe",
				env: { PORT: String(port) },
			},
});
