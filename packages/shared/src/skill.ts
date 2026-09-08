/** A globally-installed agent skill (issue #60). Installed once, enabled
 * per-Repo — see apps/server/src/skills/store.ts. */
export type Skill = {
	/** `{source}/{slug}`, e.g. `mattpocock/skills/tdd`. */
	id: string;
	/** Owner/repo the skill came from, e.g. `mattpocock/skills`. */
	source: string;
	slug: string;
	/** `name` from SKILL.md frontmatter. */
	name: string;
	/** `description` from SKILL.md frontmatter — what the model matches on to
	 * decide the skill is relevant. */
	description: string;
	sourceUrl: string;
	/** Epoch seconds. */
	installedAt: number;
};

/** An installed skill plus whether one particular Repo has it turned on. */
export type RepoSkill = Skill & { enabled: boolean };

/** One skills.sh search hit, for the install dialog. */
export type SkillSearchResult = {
	id: string;
	name: string;
	source: string;
	slug: string;
	installs: number;
};
