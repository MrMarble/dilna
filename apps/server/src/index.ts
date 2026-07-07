import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { closeDb, getDataDir, getDb, getDbPath } from "./db/index";
import { reposRoute } from "./routes/repos";
import { sessionsRoute } from "./routes/sessions";
import { streamRoute } from "./routes/stream";
import { sessionManager } from "./sessions/manager";

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

const port = Number(process.env.PORT ?? 3001);
serve({ fetch: app.fetch, port }, async (info) => {
	console.log(`dilna server listening on http://localhost:${info.port}`);
	getDb();
	// On boot, flip any non-idle sessions back to idle — their agent
	// processes died when the previous server exited (ADR-0003).
	await sessionManager.resetAllToIdle();
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
