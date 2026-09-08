import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { getDataDir, getDb } from "../db";
import {
	repoSkills as repoSkillsTable,
	skills as skillsTable,
} from "../db/schema";
import { fetchSkillFiles, parseSkillSource, type SkillFiles } from "./registry";

/**
 * The skill catalog: install once globally, enable per Repo (issue #60).
 *
 * Storage is split deliberately:
 *
 * - **Files on disk**, under `<data>/skills/<id>/`, one copy per skill no
 *   matter how many Repos enable it. They live on disk rather than in a DB
 *   blob because a skill is a *folder* (SKILL.md plus siblings it links to by
 *   relative path), and because `pi-agent-core`'s `loadSkills` — the loader
 *   dilna hands these to — takes directory paths. A DB-blob store would mean
 *   materializing a temp dir on every session start just to satisfy it.
 *   (This is why the storage choice differs from ADR-0018's "a DB row, not a
 *   file" for repo memory: memory is one bounded string, a skill is a tree.)
 * - **DB rows** for the catalog (`skills`) and the per-Repo enablement join
 *   (`repo_skills`), which is what the management UI lists and toggles.
 *
 * Every write goes through this module, mirroring `repos/memory.ts`'s
 * single-choke-point shape — so an approval/scanning gate can be added at
 * `installSkill` later without touching route or agent wiring.
 */

/** A skill as shown in the management UI. */
export type InstalledSkill = {
	id: string;
	source: string;
	slug: string;
	name: string;
	description: string;
	sourceUrl: string;
	installedAt: number;
};

/** An installed skill plus whether it's on for the Repo being viewed. */
export type RepoSkill = InstalledSkill & { enabled: boolean };

/** Root of the single global skill store. */
export function getSkillsDir(): string {
	return path.join(getDataDir(), "skills");
}

/** Where one skill's files live. `id` is `{source}/{slug}`, so this nests. */
export function getSkillDir(id: string): string {
	return path.join(getSkillsDir(), ...id.split("/"));
}

/**
 * `name` and `description` out of a SKILL.md's YAML frontmatter. Deliberately
 * a small hand-rolled reader rather than a YAML dependency: the spec requires
 * exactly these two scalar keys, and dilna only needs them to label the row —
 * the file itself stays the source of truth and is what `loadSkills` parses
 * properly at agent-start time.
 */
export function parseSkillFrontmatter(md: string): {
	name?: string;
	description?: string;
} {
	const match = md.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
	if (!match?.[1]) return {};
	const out: { name?: string; description?: string } = {};
	for (const line of match[1].split(/\r?\n/)) {
		const kv = line.match(/^(name|description):\s*(.*)$/);
		if (!kv?.[1]) continue;
		let value = (kv[2] ?? "").trim();
		if (
			(value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
			(value.startsWith("'") && value.endsWith("'") && value.length > 1)
		) {
			value = value.slice(1, -1);
		}
		if (kv[1] === "name") out.name = value;
		else out.description = value;
	}
	return out;
}

/** Every installed skill, newest first. */
export async function listSkills(): Promise<InstalledSkill[]> {
	const db = getDb();
	const rows = db.select().from(skillsTable).all();
	return rows
		.map((r) => ({
			id: r.id,
			source: r.source,
			slug: r.slug,
			name: r.name,
			description: r.description,
			sourceUrl: r.sourceUrl,
			installedAt: r.installedAt,
		}))
		.sort((a, b) => b.installedAt - a.installedAt);
}

/** Every installed skill, flagged with whether `repoId` has it enabled. */
export async function listSkillsForRepo(repoId: string): Promise<RepoSkill[]> {
	const db = getDb();
	const enabled = new Set(
		db
			.select()
			.from(repoSkillsTable)
			.where(eq(repoSkillsTable.repoId, repoId))
			.all()
			.map((r) => r.skillId),
	);
	const all = await listSkills();
	return all.map((s) => ({ ...s, enabled: enabled.has(s.id) }));
}

/** Ids of the skills enabled for a Repo. */
export async function listEnabledSkillIds(repoId: string): Promise<string[]> {
	const db = getDb();
	return db
		.select()
		.from(repoSkillsTable)
		.where(eq(repoSkillsTable.repoId, repoId))
		.all()
		.map((r) => r.skillId);
}

/**
 * Directories to hand `loadSkills` for a Session on this Repo — one per
 * enabled skill. Skills disabled for the Repo are simply absent, so a
 * disabled skill costs the agent nothing while its files stay installed for
 * every other Repo.
 */
export async function getEnabledSkillDirs(repoId: string): Promise<string[]> {
	const ids = await listEnabledSkillIds(repoId);
	return ids.map((id) => getSkillDir(id));
}

function writeSkillFiles(id: string, files: SkillFiles): void {
	const dir = getSkillDir(id);
	// Replace wholesale so a reinstall can't leave orphaned files from a
	// previous version behind.
	rmSync(dir, { recursive: true, force: true });
	for (const [rel, body] of files) {
		const target = path.join(dir, rel);
		// Second line of defence behind registry.ts's archive-path checks: never
		// write outside the skill's own directory.
		if (!target.startsWith(`${dir}${path.sep}`) && target !== dir) continue;
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, body);
	}
}

export type InstallResult =
	| { ok: true; skill: InstalledSkill; replaced: boolean }
	| { ok: false; error: string };

/**
 * Install (or reinstall) a skill from a skills.sh / GitHub URL, globally.
 *
 * Installing does **not** enable it anywhere: a freshly installed skill is
 * off for every Repo until explicitly turned on. Third-party content lands
 * straight in an Agent's context, so "off until asked for" is the safe
 * default (and matches the per-Repo enablement model — there's no sensible
 * "which Repos?" answer to guess at install time).
 */
export async function installSkill(input: string): Promise<InstallResult> {
	const source = parseSkillSource(input);
	if (!source) {
		return {
			ok: false,
			error:
				"Could not parse that as a skill source. Paste a skills.sh URL (https://www.skills.sh/owner/repo/skill) or a GitHub repository URL.",
		};
	}

	let fetched: { files: SkillFiles; skillDir: string };
	try {
		fetched = await fetchSkillFiles(source);
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : "Failed to fetch skill.",
		};
	}

	const skillMd = fetched.files.get("SKILL.md");
	if (!skillMd) return { ok: false, error: "Skill has no SKILL.md." };

	const meta = parseSkillFrontmatter(skillMd.toString("utf8"));
	const slug =
		source.skill ?? fetched.skillDir.split("/").at(-1) ?? meta.name ?? "";
	if (!slug) return { ok: false, error: "Could not determine the skill name." };

	const id = `${source.repo}/${slug}`;
	const db = getDb();
	const existing = db
		.select()
		.from(skillsTable)
		.where(eq(skillsTable.id, id))
		.get();

	writeSkillFiles(id, fetched.files);

	const row = {
		id,
		source: source.repo,
		slug,
		name: meta.name || slug,
		description: meta.description ?? "",
		sourceUrl: `https://github.com/${source.repo}`,
	};
	db.insert(skillsTable)
		.values(row)
		.onConflictDoUpdate({
			target: skillsTable.id,
			set: {
				name: row.name,
				description: row.description,
				sourceUrl: row.sourceUrl,
				updatedAt: Math.floor(Date.now() / 1000),
			},
		})
		.run();

	const saved = db
		.select()
		.from(skillsTable)
		.where(eq(skillsTable.id, id))
		.get();
	return {
		ok: true,
		replaced: Boolean(existing),
		skill: {
			id,
			source: row.source,
			slug: row.slug,
			name: row.name,
			description: row.description,
			sourceUrl: row.sourceUrl,
			installedAt: saved?.installedAt ?? Math.floor(Date.now() / 1000),
		},
	};
}

/**
 * Remove a skill globally: its files, its catalog row, and its enablement
 * rows for every Repo (nothing else would ever clean those up — same
 * reasoning as `RepoManager.delete` dropping the Repo's memory row).
 */
export async function uninstallSkill(id: string): Promise<void> {
	const db = getDb();
	rmSync(getSkillDir(id), { recursive: true, force: true });
	db.delete(repoSkillsTable).where(eq(repoSkillsTable.skillId, id)).run();
	db.delete(skillsTable).where(eq(skillsTable.id, id)).run();
}

/** Turn a skill on/off for one Repo. Idempotent in both directions. */
export async function setSkillEnabled(
	skillId: string,
	repoId: string,
	enabled: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const db = getDb();
	const skill = db
		.select()
		.from(skillsTable)
		.where(eq(skillsTable.id, skillId))
		.get();
	if (!skill) return { ok: false, error: "Skill is not installed." };

	if (enabled) {
		db.insert(repoSkillsTable)
			.values({ skillId, repoId })
			.onConflictDoNothing()
			.run();
	} else {
		db.delete(repoSkillsTable)
			.where(
				and(
					eq(repoSkillsTable.skillId, skillId),
					eq(repoSkillsTable.repoId, repoId),
				),
			)
			.run();
	}
	return { ok: true };
}

/** Drop every enablement row for a deleted Repo. */
export function deleteRepoSkills(repoId: string): void {
	getDb()
		.delete(repoSkillsTable)
		.where(eq(repoSkillsTable.repoId, repoId))
		.run();
}
