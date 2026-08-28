import { existsSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { validateProviderConfig } from "./agents/providerConfig";
import { closeDb, getDataDir, getDb, getDbPath } from "./db/index";
import { repoManager } from "./repos/manager";
import { reposRoute } from "./routes/repos";
import { sessionsRoute } from "./routes/sessions";
import { streamRoute } from "./routes/stream";
import { sessionManager } from "./sessions/manager";

// Fail fast (ADR-0020): every session on this instance talks to whichever
// LLM provider/model DILNA_PROVIDER/DILNA_MODEL select — a misconfiguration
// here used to only surface on a user's first message (claude.ts inherited
// process.env wholesale and never validated ANTHROPIC_API_KEY/CLI auth
// existed before spawning); refusing to start with a specific error is a
// strict improvement, not just parity.
const providerConfig = validateProviderConfig(process.env);
if (!providerConfig.ok) {
	console.error(`[dilna] startup configuration error: ${providerConfig.error}`);
	process.exit(1);
}

const app = new Hono();
app.use(logger());
app.use(
	cors({
		origin: process.env.DILNA_WEB_ORIGIN ?? "http://localhost:5174",
		allowHeaders: ["Content-Type", "Authorization"],
		allowMethods: ["GET", "POST", "DELETE", "PATCH"],
	}),
);

app.route("/api/repos", reposRoute);
app.route("/api/sessions", sessionsRoute);
app.route("/api/stream", streamRoute);

app.get("/api/health", (c) =>
	c.json({ ok: true, dataDir: getDataDir(), db: getDbPath() }),
);

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
serve({ fetch: app.fetch, port }, async (info) => {
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

async function shutdown() {
	// Best-effort cleanup: stop all running agents, then close the DB.
	// SessionManager doesn't expose a list-active method yet, so the
	// per-session stop happens lazily; for MVP we just close the DB.
	closeDb();
	process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
