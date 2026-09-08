import { loadSkills, type Skill } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { getEnabledSkillDirs } from "./store";

/**
 * Loading a Repo's enabled skills for an Agent (issue #60).
 *
 * `loadSkills` comes from `@earendil-works/pi-agent-core` — already a direct
 * dependency, and (contrary to earlier notes on the issue) re-exported from
 * the package root as of 0.84.3 (`dist/index.d.ts` does
 * `export * from "./harness/skills.ts"`), so no deep import into `dist/` and
 * no upstream ask are needed. It handles the parts dilna shouldn't reinvent:
 * recursive `SKILL.md` discovery, frontmatter parsing, ignore-file handling,
 * and structured `diagnostics` for malformed skills instead of throwing.
 *
 * **Progressive disclosure** is the point of the split between this and
 * `pi.ts`: only each skill's `name`/`description` goes into the system prompt
 * (a couple of lines per skill), and the full `content` is fetched on demand
 * by the `read_skill` tool. Injecting every enabled skill's body would put
 * the whole library in context on every turn, which is what the "load only
 * when relevant" framing in issue #60 exists to avoid.
 */

/** A skill loaded off disk, ready to be listed or read. */
export type LoadedSkill = Skill;

/**
 * Every skill enabled for `repoId`, loaded from the global store. Best-effort:
 * a skill whose files are unreadable or whose frontmatter is malformed is
 * skipped (with a server-side warning) rather than failing the session start —
 * one bad skill shouldn't make a Repo unusable.
 */
export async function loadSkillsForRepo(
	repoId: string,
): Promise<LoadedSkill[]> {
	const dirs = await getEnabledSkillDirs(repoId);
	if (dirs.length === 0) return [];

	try {
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const { skills, diagnostics } = await loadSkills(env, dirs);
		for (const d of diagnostics) {
			console.warn(`[dilna] skill ${d.code} at ${d.path}: ${d.message}`);
		}
		return skills;
	} catch (err) {
		console.warn(
			`[dilna] failed to load skills for repo ${repoId}:`,
			err instanceof Error ? err.message : err,
		);
		return [];
	}
}

/**
 * The skills section appended to a Session's system prompt: one line per
 * skill (name + description) and how to read the full text. Returns "" when
 * the Repo has no skills enabled, so a Repo that doesn't use skills pays
 * nothing for the feature.
 */
export function formatSkillsPrompt(skills: LoadedSkill[]): string {
	if (skills.length === 0) return "";
	const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
	return `\n\nSKILLS\nProcedures installed for this Repo. Each line is a skill's name and when it applies — the full instructions are NOT loaded yet. When one is relevant to the task at hand, call \`read_skill\` with its name to load it, then follow it.\n\n${lines.join("\n")}`;
}
