import type { RepoSkill } from "@dilna/shared";
import { useEffect, useState } from "react";
import { api } from "@/api/client";

/**
 * The Skills a Repo has enabled, for the composer's slash-command menu.
 *
 * Only enabled Skills are returned: the catalog also holds installed-but-
 * disabled ones, and offering those would autocomplete a command the agent
 * has no `read_skill` entry for (`formatSkillsPrompt` lists enabled Skills
 * only — see ADR-0028).
 *
 * Fetched once per Repo rather than per keystroke — the set only changes from
 * the Skills page, which is a separate view, so a mount-time read is current
 * for the lifetime of a composer. Failures resolve to an empty list: a
 * missing menu degrades to today's type-it-from-memory behaviour, which is
 * not worth surfacing an error in the composer for.
 */
export function useRepoSkills(repoId: string): RepoSkill[] {
	const [skills, setSkills] = useState<RepoSkill[]>([]);

	useEffect(() => {
		let cancelled = false;
		api.skills
			.forRepo(repoId)
			.then(({ skills: all }) => {
				if (!cancelled) setSkills(all.filter((s) => s.enabled));
			})
			.catch(() => {
				if (!cancelled) setSkills([]);
			});
		return () => {
			cancelled = true;
		};
	}, [repoId]);

	return skills;
}
