import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../db";
import { skills as skillsTable } from "../db/schema";
import {
	deleteRepoSkills,
	getEnabledSkillDirs,
	getSkillDir,
	listSkills,
	listSkillsForRepo,
	parseSkillFrontmatter,
	setSkillEnabled,
	uninstallSkill,
} from "./store";

let dataDir: string;
let oldDataDir: string | undefined;

beforeAll(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-skills-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;
});

afterAll(() => {
	closeDb();
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
});

/** Insert a catalog row directly — install-from-network is covered by
 * registry.test.ts's parsing tests; these cases are about the
 * global-install/per-repo-enable model, not the download. */
function seedSkill(id: string, name = id.split("/").at(-1) ?? id) {
	getDb()
		.insert(skillsTable)
		.values({
			id,
			source: id.split("/").slice(0, 2).join("/"),
			slug: id.split("/").at(-1) ?? id,
			name,
			description: `${name} description`,
			sourceUrl: `https://github.com/${id.split("/").slice(0, 2).join("/")}`,
		})
		.onConflictDoNothing()
		.run();
}

describe("parseSkillFrontmatter", () => {
	it("reads name and description from SKILL.md frontmatter", () => {
		const md = `---\nname: tdd\ndescription: Test-driven development. Use when building test-first.\n---\n\n# Test-Driven Development\n`;
		expect(parseSkillFrontmatter(md)).toEqual({
			name: "tdd",
			description: "Test-driven development. Use when building test-first.",
		});
	});

	it("strips surrounding quotes from values", () => {
		const md = `---\nname: "quoted"\ndescription: 'single'\n---\nbody`;
		expect(parseSkillFrontmatter(md)).toEqual({
			name: "quoted",
			description: "single",
		});
	});

	it("returns nothing for a file with no frontmatter", () => {
		expect(parseSkillFrontmatter("# Just a heading\n")).toEqual({});
	});
});

describe("skill catalog", () => {
	it("lists nothing when no skills are installed", async () => {
		expect(await listSkills()).toEqual([]);
	});

	it("enables a skill for one repo without affecting another", async () => {
		seedSkill("owner/repo/alpha");

		await setSkillEnabled("owner/repo/alpha", "repo-1", true);

		const forRepo1 = await listSkillsForRepo("repo-1");
		const forRepo2 = await listSkillsForRepo("repo-2");
		expect(forRepo1.find((s) => s.id === "owner/repo/alpha")?.enabled).toBe(
			true,
		);
		// The skill is installed globally, so it's *listed* for repo-2 too —
		// just switched off there. That's the whole point of the model.
		expect(forRepo2.find((s) => s.id === "owner/repo/alpha")?.enabled).toBe(
			false,
		);
	});

	it("keeps one copy on disk regardless of how many repos enable it", async () => {
		seedSkill("owner/repo/shared");
		await setSkillEnabled("owner/repo/shared", "repo-1", true);
		await setSkillEnabled("owner/repo/shared", "repo-2", true);

		const dirs1 = await getEnabledSkillDirs("repo-1");
		const dirs2 = await getEnabledSkillDirs("repo-2");
		const dir = getSkillDir("owner/repo/shared");
		expect(dirs1).toContain(dir);
		expect(dirs2).toContain(dir);
	});

	it("is idempotent when enabling twice", async () => {
		seedSkill("owner/repo/twice");
		await setSkillEnabled("owner/repo/twice", "repo-1", true);
		await setSkillEnabled("owner/repo/twice", "repo-1", true);

		const dirs = await getEnabledSkillDirs("repo-1");
		expect(dirs.filter((d) => d.endsWith("twice"))).toHaveLength(1);
	});

	it("disables a skill without uninstalling it", async () => {
		seedSkill("owner/repo/toggle");
		await setSkillEnabled("owner/repo/toggle", "repo-1", true);
		await setSkillEnabled("owner/repo/toggle", "repo-1", false);

		const forRepo = await listSkillsForRepo("repo-1");
		expect(forRepo.find((s) => s.id === "owner/repo/toggle")?.enabled).toBe(
			false,
		);
		// Still installed — only the enablement row went.
		expect((await listSkills()).some((s) => s.id === "owner/repo/toggle")).toBe(
			true,
		);
	});

	it("refuses to enable a skill that is not installed", async () => {
		const result = await setSkillEnabled("owner/repo/ghost", "repo-1", true);
		expect(result.ok).toBe(false);
	});

	it("uninstalling removes the skill everywhere it was enabled", async () => {
		seedSkill("owner/repo/gone");
		await setSkillEnabled("owner/repo/gone", "repo-1", true);
		await setSkillEnabled("owner/repo/gone", "repo-2", true);

		await uninstallSkill("owner/repo/gone");

		expect((await listSkills()).some((s) => s.id === "owner/repo/gone")).toBe(
			false,
		);
		expect(await getEnabledSkillDirs("repo-1")).not.toContain(
			getSkillDir("owner/repo/gone"),
		);
		expect(await getEnabledSkillDirs("repo-2")).not.toContain(
			getSkillDir("owner/repo/gone"),
		);
	});

	it("deleting a repo drops its enablement rows but keeps the skill", async () => {
		seedSkill("owner/repo/kept");
		await setSkillEnabled("owner/repo/kept", "repo-doomed", true);
		await setSkillEnabled("owner/repo/kept", "repo-1", true);

		deleteRepoSkills("repo-doomed");

		expect(await getEnabledSkillDirs("repo-doomed")).toEqual([]);
		expect(await getEnabledSkillDirs("repo-1")).toContain(
			getSkillDir("owner/repo/kept"),
		);
		expect((await listSkills()).some((s) => s.id === "owner/repo/kept")).toBe(
			true,
		);
	});
});
