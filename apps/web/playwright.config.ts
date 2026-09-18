import { defineConfig, devices } from "@playwright/test";

/**
 * E2E regression suite.
 *
 * Unit tests mock the API; these run the real server against a real (scratch)
 * SQLite DB with the real built SPA, which is the only place wiring bugs
 * between the parts actually show up.
 *
 * Two instances run per invocation (issue #238):
 *
 *   * `empty` — nothing cloned. `shell.spec.ts` and `clone-repo.spec.ts`
 *     assert on the zero state, so they need an instance that is genuinely
 *     empty; seeding in place would delete the fixture they exist to guard.
 *   * `seeded` — one repo cloned from a local bare remote, one Session. This
 *     is the loaded state the suite previously couldn't reach, and the
 *     `loaded-state.spec.ts` specs run only here.
 *
 * `testMatch` is what routes each spec to its instance, so a spec can't
 * accidentally run against the wrong fixture — see each project's `testIgnore`
 * for the counterpart to its `testMatch`.
 *
 * `PLAYWRIGHT_BASE_URL` points the run at an instance you already have going
 * and skips the managed servers — useful for iterating against `pnpm dev`.
 * That mode collapses both projects onto the one URL, so a seeded spec will
 * fail its fixture lookup unless the instance you point at happens to be
 * seeded; the error message says as much.
 */

const emptyPort = Number(process.env.PLAYWRIGHT_PORT ?? 4311);
const seededPort = Number(process.env.PLAYWRIGHT_SEEDED_PORT ?? 4312);
const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const emptyBaseUrl = externalBaseUrl ?? `http://localhost:${emptyPort}`;

/** Specs that assert on the empty instance. */
const EMPTY_SPECS = ["shell.spec.ts", "clone-repo.spec.ts"];
/** Specs that need the seeded instance. */
const SEEDED_SPECS = ["loaded-state.spec.ts"];

export default defineConfig({
	testDir: "./e2e",
	// Fail the run if a `test.only` is committed.
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 2 : 0,
	// Each instance is one server process and one DB, shared by the specs
	// matched to it, so specs must not race each other's state. Revisit only
	// alongside per-worker isolation.
	workers: 1,
	fullyParallel: false,
	reporter: process.env.CI
		? [["github"], ["html", { open: "never" }]]
		: [["list"]],
	use: {
		// Artefacts only for failures — keeps a green run cheap.
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		video: "retain-on-failure",
	},
	projects: [
		{
			name: "empty",
			testMatch: EMPTY_SPECS,
			use: {
				// Desktop viewport: the sidebar is only rendered above the md
				// breakpoint (768px), so a smaller viewport would hide most of
				// the navigation behind a drawer.
				...devices["Desktop Chrome"],
				baseURL: emptyBaseUrl,
			},
		},
		{
			name: "seeded",
			testMatch: SEEDED_SPECS,
			use: {
				...devices["Desktop Chrome"],
				baseURL: externalBaseUrl ?? `http://localhost:${seededPort}`,
			},
		},
	],
	webServer: externalBaseUrl
		? undefined
		: [
				{
					name: "empty instance",
					command: "node e2e/server.mjs",
					// `url` (not `port`): waits for a real 200 from the API, so the
					// suite can't start against a socket that's open but not serving.
					// For the seeded instance this also waits for seeding, since
					// `server.mjs` seeds before it lets this probe succeed.
					url: `http://localhost:${emptyPort}/api/repos`,
					reuseExistingServer: !process.env.CI,
					timeout: 60_000,
					stdout: "pipe",
					stderr: "pipe",
					env: { PORT: String(emptyPort) },
				},
				{
					name: "seeded instance",
					command: "node e2e/server.mjs --seed",
					url: `http://localhost:${seededPort}/api/repos`,
					reuseExistingServer: !process.env.CI,
					timeout: 60_000,
					stdout: "pipe",
					stderr: "pipe",
					env: { PORT: String(seededPort) },
				},
			],
});
