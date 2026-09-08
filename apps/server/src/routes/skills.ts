import type { RepoSkill, Skill, SkillSearchResult } from "@dilna/shared";
import { decodeSkillId } from "@dilna/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { repoManager } from "../repos/manager";
import { searchSkills } from "../skills/registry";
import {
	installSkill,
	listSkills,
	listSkillsForRepo,
	setSkillEnabled,
	uninstallSkill,
} from "../skills/store";

/**
 * Skill management (issue #60): a global catalog plus per-Repo enablement.
 *
 * The split of routes mirrors the storage model — `/api/skills` is the global
 * install/uninstall surface, and enablement lives under a Repo
 * (`/api/skills/:repoId/...` via `/enabled`) because that's the only part
 * that varies per Repo.
 */
export const skillsRoute = new Hono();

const installBodySchema = z.object({
	/** A skills.sh or GitHub URL, or `owner/repo/skill` shorthand. */
	url: z.string().min(1),
});

const enabledBodySchema = z.object({
	repoId: z.string().min(1),
	enabled: z.boolean(),
});

/** Every installed skill (global catalog). */
skillsRoute.get("/", async (c) => {
	const skills: Skill[] = await listSkills();
	return c.json({ skills });
});

/**
 * Search skills.sh. Never fails the request on a registry outage — returns an
 * empty list, since installing by pasted URL has to keep working regardless.
 */
skillsRoute.get("/search", async (c) => {
	const q = c.req.query("q") ?? "";
	const owner = c.req.query("owner") || undefined;
	const results: SkillSearchResult[] = await searchSkills(q, owner);
	return c.json({ results });
});

/** Installed skills, flagged with whether this Repo has each enabled. */
skillsRoute.get("/repo/:repoId", async (c) => {
	const repoId = c.req.param("repoId");
	const repo = await repoManager.get(repoId);
	if (!repo) throw new HTTPException(404, { message: "repo not found" });
	const skills: RepoSkill[] = await listSkillsForRepo(repoId);
	return c.json({ skills });
});

/** Install a skill globally (does not enable it for any Repo). */
skillsRoute.post("/", zValidator("json", installBodySchema), async (c) => {
	const body = c.req.valid("json");
	const result = await installSkill(body.url);
	if (!result.ok) throw new HTTPException(400, { message: result.error });
	return c.json({ skill: result.skill }, result.replaced ? 200 : 201);
});

/**
 * Turn a skill on/off for one Repo.
 *
 * `id` is `{source}/{slug}` (e.g. `owner/repo/skill`), so the client
 * base64url-encodes it (`encodeSkillId`, `@dilna/shared`) into one path
 * segment with no `/` in it at all. Two prior versions of this route each
 * worked in isolation but broke in a real deployment: a raw multi-segment
 * match (`/:id{.+}/enabled`) silently stopped matching once `sessionsRoute`'s
 * `POST /orchestrator` + `POST /:id/messages` were also registered (Hono's
 * RegExpRouter merges every mounted sub-app into one combined matcher), and
 * switching to a single-segment `/:id/enabled` with `encodeURIComponent`
 * (`%2F` for each `/`) still failed once deployed behind an edge that
 * canonicalizes URL paths — confirmed via a HAR capture showing a 307
 * redirect that decoded `%2F` back to `/` before the request ever reached
 * dilna. Base64url has no `/` or `%` in its alphabet, so there's nothing left
 * for any intermediary to "clean".
 */
skillsRoute.post(
	"/:id/enabled",
	zValidator("json", enabledBodySchema),
	async (c) => {
		const id = decodeSkillId(c.req.param("id"));
		const body = c.req.valid("json");
		const repo = await repoManager.get(body.repoId);
		if (!repo) throw new HTTPException(404, { message: "repo not found" });

		const result = await setSkillEnabled(id, body.repoId, body.enabled);
		if (!result.ok) throw new HTTPException(404, { message: result.error });
		return c.json({ ok: true });
	},
);

/** Uninstall globally — files, catalog row, and every Repo's enablement.
 * Same base64url-encoded `id` as the `/enabled` route above. */
skillsRoute.delete("/:id", async (c) => {
	await uninstallSkill(decodeSkillId(c.req.param("id")));
	return c.json({ ok: true });
});
