import { paths } from "@dilna/shared";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { configRoute } from "./config";
import { pushRoute } from "./push";
import { createReposRoute } from "./repos";
import { createSessionsRoute } from "./sessions";
import { createSkillsRoute } from "./skills";
import { createStreamRoute } from "./stream";
import { usageRoute } from "./usage";

/**
 * The address half of the API contract (see `@dilna/shared`'s `paths.ts`).
 *
 * The client calls through those builders; this asserts the server *declares*
 * the same addresses. Before the builders existed both sides hand-typed every
 * path, so renaming `/changed-files` to `/changed_files` server-side was a
 * green build on both sides and a runtime 404 on the web — the same class of
 * drift ADR-0039/0040 closed for request bodies and response envelopes.
 *
 * The routers are constructed with an empty stub: only the route *table* is
 * under test, and no handler runs without a request. Mounting mirrors
 * `index.ts`, which is the point — a route moved or renamed there fails here.
 */

function buildApp(): Hono {
	const app = new Hono();
	// biome-ignore lint/suspicious/noExplicitAny: route factories only need the shape; no handler runs.
	const noManagers = {} as any;
	app.route("/api/config", configRoute);
	app.route("/api/push", pushRoute);
	app.route("/api/repos", createReposRoute(noManagers));
	app.route("/api/sessions", createSessionsRoute(noManagers));
	app.route("/api/skills", createSkillsRoute(noManagers));
	app.route("/api/stream", createStreamRoute(noManagers));
	app.route("/api/usage", usageRoute);
	return app;
}

/** Hono's route table as `"METHOD /path"`, param names normalized to `:x` so
 * the server's `:attachmentId` and a builder's probe value compare equal. */
function routeSignatures(app: Hono): Set<string> {
	return new Set(
		app.routes.map((r) => `${r.method} ${r.path.replace(/:[A-Za-z]+/g, ":x")}`),
	);
}

const app = buildApp();
const declared = routeSignatures(app);

/** A builder's output, with its probe value mapped to the same `:x` the
 * server's route table uses. Any query string is dropped: a route's *path*
 * is what the server declares, and its query params are validated by a
 * schema (`usageQuerySchema`, `searchSkillsQuerySchema`, …) rather than
 * forming part of the address. */
function asTemplate(built: string): string {
	return built.split("?")[0]?.replaceAll("__p__", ":x") ?? "";
}

/** Assert a builder's path is one the server actually declares. */
function expectDeclared(method: string, built: string) {
	const template = asTemplate(built);
	expect(
		declared.has(`${method} ${template}`),
		`no route declared for ${method} ${template}`,
	).toBe(true);
}

describe("server route addresses", () => {
	it("declares every repo path the client calls", () => {
		expect(paths.repos.list()).toBe("/api/repos");
		expectDeclared("GET", paths.repos.list());
		expectDeclared("POST", paths.repos.list());
		expectDeclared("GET", paths.repos.get("__p__"));
		expectDeclared("GET", paths.repos.stats("__p__"));
		expectDeclared("POST", paths.repos.pull("__p__"));
		expectDeclared("POST", paths.repos.sync("__p__"));
		expectDeclared("DELETE", paths.repos.get("__p__"));
	});

	it("declares every session path the client calls", () => {
		expect(paths.sessions.list()).toBe("/api/sessions");
		expectDeclared("GET", paths.sessions.list());
		expectDeclared("POST", paths.sessions.list());
		expectDeclared("GET", paths.sessions.get("__p__"));
		expectDeclared("DELETE", paths.sessions.get("__p__"));
		expectDeclared("GET", paths.sessions.messages("__p__"));
		expectDeclared("POST", paths.sessions.messages("__p__"));
		expectDeclared("GET", paths.sessions.changedFiles("__p__"));
		expectDeclared("GET", paths.sessions.commits("__p__"));
		expectDeclared("GET", paths.sessions.transcript("__p__"));
		expectDeclared("POST", paths.sessions.orchestrator());
		expectDeclared("GET", paths.sessions.queue("__p__"));
		expectDeclared("POST", paths.sessions.queue("__p__"));
		expectDeclared("DELETE", paths.sessions.queuedMessage("__p__", "__p__"));
		expectDeclared("POST", paths.sessions.attachments("__p__"));
		expectDeclared("GET", paths.sessions.attachment("__p__", "__p__"));
		expectDeclared("GET", paths.sessions.artefacts("__p__"));
		expectDeclared("GET", paths.sessions.scores("__p__"));
		expectDeclared("POST", paths.sessions.turnScores("__p__", "__p__"));
		expectDeclared("GET", paths.sessions.artefact("__p__", "__p__"));
		expectDeclared("POST", paths.sessions.stop("__p__"));
		expectDeclared("GET", paths.sessions.stream("__p__"));
	});

	it("declares every config, skills, push and usage path the client calls", () => {
		expectDeclared("GET", paths.config.get());
		expectDeclared("PUT", paths.config.get());
		expectDeclared("DELETE", paths.config.get());
		expectDeclared("PUT", paths.config.credentials());
		expectDeclared("DELETE", paths.config.credential("__p__"));
		expectDeclared("POST", paths.config.anthropicOauthStart());
		expectDeclared("POST", paths.config.anthropicOauthComplete());
		expectDeclared("POST", paths.config.anthropicOauthCancel());
		expectDeclared("DELETE", paths.config.anthropicOauth());
		expectDeclared("POST", paths.config.customProviders());
		expectDeclared("PUT", paths.config.customProvider("__p__"));
		expectDeclared("DELETE", paths.config.customProvider("__p__"));
		expectDeclared("GET", paths.skills.list());
		expectDeclared("POST", paths.skills.list());
		expectDeclared("GET", paths.skills.search("q"));
		expectDeclared("GET", paths.skills.forRepo("__p__"));
		expectDeclared("POST", paths.skills.enabled("__p__"));
		expectDeclared("DELETE", paths.skills.item("__p__"));
		expectDeclared("GET", paths.push.key());
		expectDeclared("POST", paths.push.subscribe());
		expectDeclared("POST", paths.push.unsubscribe());
		expectDeclared("GET", paths.usage.summary());
		expectDeclared("GET", paths.usage.disk());
		expectDeclared("GET", paths.stream());
	});

	it("catches a drifted path literal on either side", () => {
		// Sanity: the check above is only worth having if it actually fails for
		// a path the server doesn't declare. A missing route must be rejected.
		expect(declared.has("GET /api/sessions/:x/changed_files")).toBe(false);
		expect(() =>
			expectDeclared("GET", "/api/sessions/__p__/changed_files"),
		).toThrow();
	});
});
