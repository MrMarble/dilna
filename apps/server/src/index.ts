import { existsSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { primeCustomProviders } from "./agents/customProviders";
import { validateProviderConfig } from "./agents/providerConfig";
import { getOverride, primeOverrideFromDb } from "./agents/providerConfigStore";
import { primeProviderCredentials } from "./agents/providerCredentials";
import { closeDb, getDataDir, getDb, getDbPath } from "./db/index";
import {
	bearerAuthMiddleware,
	hostAllowlistMiddleware,
} from "./middleware/security";
import { repoManager } from "./repos/manager";
import { configRoute } from "./routes/config";
import { reposRoute } from "./routes/repos";
import { sessionsRoute } from "./routes/sessions";
import { streamRoute } from "./routes/stream";
import { usageRoute } from "./routes/usage";
import { sessionManager } from "./sessions/manager";

// The instance's provider/model is resolved as: web-settable override (from
// the `llm_config` row) ?? DILNA_PROVIDER/DILNA_MODEL env fallback (see
// providerConfigStore.ts). At boot we prime the override cache so agent-start
// reads don't hit the DB, then sanity-check the *environment* config that
// applies when no override is set.
//
// Fail fast (ADR-0020) applied to the env path only: a misconfigured
// env-only deployment should surface at boot rather than on the user's first
// message. We deliberately warn (not `process.exit`), because unlike the
// pre-web-config era an unset env is now recoverable in place — the Settings
// view can provide a provider/model override without a restart — and booting
// is what makes that view reachable.
// Custom providers are primed first: readOverrideFromDb's validation checks
// whether a persisted override's provider is a known custom provider id, so
// that cache has to exist before primeOverrideFromDb runs.
primeCustomProviders();
primeOverrideFromDb();
primeProviderCredentials();
const envProviderConfig = validateProviderConfig(process.env);
if (!envProviderConfig.ok && !getOverride()) {
	console.warn(
		`[dilna] no override set and environment config is incomplete: ${envProviderConfig.error}. ` +
			"Every session will fail until you set DILNA_PROVIDER/DILNA_MODEL (+ API key) or " +
			"configure a provider/model in the Settings view.",
	);
}

const app = new Hono();
app.use(logger());

// Opt-in hardening against DNS rebinding / CSRF-style requests from a
// browser tab: CORS alone only stops a script from *reading* a cross-origin
// response, not from *sending* a same-site-cookie-free simple request (a
// bare GET, or a POST with a CORS-safelisted content-type) that still
// executes server-side — e.g. triggering a repo clone. Off by default (ADR-
// 0009 explicitly defers app-level auth/gating for this single-user tool);
// operators exposed beyond localhost/a trusted LAN can opt in.
const allowedHosts = process.env.DILNA_ALLOWED_HOSTS?.split(",")
	.map((h) => h.trim())
	.filter(Boolean);
if (allowedHosts?.length) {
	app.use("*", hostAllowlistMiddleware(allowedHosts));
}

// Opt-in bearer auth, same off-by-default rationale as above.
const authToken = process.env.DILNA_AUTH_TOKEN;
if (authToken) {
	app.use("/api/*", bearerAuthMiddleware(authToken, "/api/health"));
}

app.use(
	cors({
		origin: process.env.DILNA_WEB_ORIGIN ?? "http://localhost:5174",
		allowHeaders: ["Content-Type", "Authorization"],
		allowMethods: ["GET", "POST", "DELETE", "PATCH"],
	}),
);
// Nothing here needs a payload anywhere near this large (the biggest is a
// chat message's text) — this just puts a ceiling on the previously-uncapped
// request body rather than tuning it tightly.
app.use("/api/*", bodyLimit({ maxSize: 5 * 1024 * 1024 }));

app.route("/api/config", configRoute);
app.route("/api/repos", reposRoute);
app.route("/api/sessions", sessionsRoute);
app.route("/api/stream", streamRoute);
app.route("/api/usage", usageRoute);

// Flipped by `shutdown()` before it starts draining in-flight turns, so a
// k8s readiness probe hitting this stops routing new traffic to a
// terminating pod instead of racing new sends against the drain window.
let draining = false;

app.get("/api/health", (c) => {
	if (draining) {
		return c.json({ ok: false, draining: true }, 503);
	}
	return c.json({ ok: true, dataDir: getDataDir(), db: getDbPath() });
});

// Serve the built web app in production single-container deployments (the
// dev workflow serves it separately via Vite, so apps/web/dist won't exist
// there and this block no-ops). SPA fallback: any non-API, non-file GET
// falls through to index.html for client-side routing.
const webDistDir =
	process.env.DILNA_WEB_DIST ??
	path.join(import.meta.dirname, "../../web/dist");
if (existsSync(webDistDir)) {
	app.use("*", serveStatic({ root: webDistDir }));
	app.get("*", (c, next) => {
		// Don't let unmatched /api/* paths fall back to index.html — they
		// should 404, not silently return a 200 HTML page.
		if (c.req.path.startsWith("/api/")) return next();
		return serveStatic({ path: path.join(webDistDir, "index.html") })(c, next);
	});
}

const port = Number(process.env.PORT ?? 3001);
const server = serve({ fetch: app.fetch, port }, async (info) => {
	console.log(`dilna server listening on http://localhost:${info.port}`);
	getDb();
	// On boot, flip any non-idle sessions back to idle — their agent
	// processes died when the previous server exited (ADR-0003).
	await sessionManager.resetAllToIdle();
	// Backfill git defaults (origin fetch refspec, .gitmodules exclude) on
	// repos cloned before RepoManager.ensureGitDefaults existed — the bare
	// repo's config is shared by all of its worktrees, so this repairs
	// existing Sessions too.
	await repoManager.ensureAllGitDefaults();
});

// Grace window for in-flight turns to finish and persist on a *plannable*
// termination (deploy, `kubectl rollout restart`, node drain) — kept
// comfortably under k8s's default 30s `terminationGracePeriodSeconds` so
// this has time to also close the HTTP server and the DB before the kubelet
// gives up and SIGKILLs. Doesn't help against an actual SIGKILL (e.g. an
// OOM kill) — nothing running in-process can intercept that signal — see
// ADR-0026.
const SHUTDOWN_GRACE_MS = 25_000;

let shuttingDown = false;
async function shutdown() {
	// A second signal (e.g. an impatient double Ctrl-C) shouldn't restart the
	// drain from scratch.
	if (shuttingDown) return;
	shuttingDown = true;
	draining = true;
	console.log("[dilna] shutting down: draining in-flight turns...");
	await sessionManager.drain(SHUTDOWN_GRACE_MS);
	await new Promise<void>((resolve) => {
		server.close((err) => {
			if (err) console.error("[dilna] error closing HTTP server:", err);
			resolve();
		});
	});
	closeDb();
	process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
