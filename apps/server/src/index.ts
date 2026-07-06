import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { closeDb, getDataDir, getDb, getDbPath } from "./db/index";
import { reposRoute } from "./routes/repos";
import { sessionsRoute } from "./routes/sessions";
import { streamRoute } from "./routes/stream";

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
serve({ fetch: app.fetch, port }, (info) => {
	console.log(`dilna server listening on http://localhost:${info.port}`);
	getDb();
});

process.on("SIGINT", () => {
	closeDb();
	process.exit(0);
});
process.on("SIGTERM", () => {
	closeDb();
	process.exit(0);
});
