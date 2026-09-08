import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../db";
import { repos as reposTable, skills as skillsTable } from "../db/schema";
import { skillsRoute } from "./skills";

// zod validation runs in the zValidator middleware, before the handler (and
// therefore the DB/network) is ever touched — so these need no fixture.
describe("skillsRoute validation", () => {
	const app = new Hono().route("/", skillsRoute);

	it("rejects POST / with no url", async () => {
		const res = await app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	it("rejects POST / with an empty url", async () => {
		const res = await app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url: "" }),
		});
		expect(res.status).toBe(400);
	});

	it("rejects an enable toggle with no repoId", async () => {
		const res = await app.request(
			`/${encodeURIComponent("owner/repo/skill")}/enabled`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: true }),
			},
		);
		expect(res.status).toBe(400);
	});

	it("rejects an enable toggle with a non-boolean enabled", async () => {
		const res = await app.request(
			`/${encodeURIComponent("owner/repo/skill")}/enabled`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ repoId: "r1", enabled: "yes" }),
			},
		);
		expect(res.status).toBe(400);
	});

	it("returns an empty result set for a too-short search query", async () => {
		const res = await app.request("/search?q=a");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ results: [] });
	});
});

/**
 * Regression coverage for a routing bug: `id` is `{source}/{slug}` (e.g.
 * "owner/repo/skill"), which the client encodes into one path segment. A
 * prior version instead matched the raw slashes via `/:id{.+}/enabled`,
 * which worked when `skillsRoute` was tested standalone but silently
 * stopped matching once mounted alongside `sessionsRoute`'s `POST
 * /orchestrator` + `POST /:id/messages` in the real app — Hono's
 * RegExpRouter merges every mounted sub-app into one combined matcher, and
 * that specific combination broke it (a plain 404, not a validation error).
 * These hit the route end-to-end (real DB, real handler) so a regression
 * shows up as a 404 here rather than only in production routing.
 */
describe("skillsRoute /:id/enabled and DELETE /:id (real DB)", () => {
	const app = new Hono().route("/", skillsRoute);
	const skillId = "owner/repo/skill";
	let dataDir: string;
	let oldDataDir: string | undefined;

	beforeAll(() => {
		dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-skills-route-"));
		oldDataDir = process.env.DILNA_DATA_DIR;
		process.env.DILNA_DATA_DIR = dataDir;
	});

	afterAll(() => {
		closeDb();
		if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
		else process.env.DILNA_DATA_DIR = oldDataDir;
		rmSync(dataDir, { recursive: true, force: true });
	});

	afterEach(() => {
		const db = getDb();
		db.delete(skillsTable).run();
		db.delete(reposTable).run();
	});

	function seedSkillAndRepo() {
		const db = getDb();
		db.insert(skillsTable)
			.values({
				id: skillId,
				source: "owner/repo",
				slug: "skill",
				name: "skill",
				description: "a skill with a multi-segment id",
				sourceUrl: "https://github.com/owner/repo",
			})
			.run();
		db.insert(reposTable)
			.values({
				id: "r1",
				slug: "r1",
				path: "/tmp/r1",
				defaultBranch: "main",
				remoteUrl: "https://github.com/owner/r1",
			})
			.run();
	}

	it("enables a multi-segment-id skill for a Repo", async () => {
		seedSkillAndRepo();
		const res = await app.request(`/${encodeURIComponent(skillId)}/enabled`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ repoId: "r1", enabled: true }),
		});
		expect(res.status).toBe(200);
	});

	it("uninstalls a multi-segment-id skill", async () => {
		seedSkillAndRepo();
		const res = await app.request(`/${encodeURIComponent(skillId)}`, {
			method: "DELETE",
		});
		expect(res.status).toBe(200);
	});
});
