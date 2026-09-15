import type { RepoSkill } from "@dilna/shared";

/**
 * Slash-command autocomplete for the composer: typing `/` on an otherwise
 * empty composer offers the Skills this Repo has enabled, so the user picks
 * one from a list instead of recalling its name from memory.
 *
 * Scoped deliberately narrowly — only a `/` in the *first* column of an
 * otherwise-single-line draft opens the menu. A `/` mid-sentence is a path
 * separator or a date far more often than it is a command, and the agent
 * itself only treats a leading `/skill-name` as an invocation.
 *
 * Kept separate from the component so the matching rules are unit-testable
 * without rendering a composer, and so `ChatShell` only wires the pieces.
 */

/** A Skill offered in the menu. `name` is what gets inserted. */
export type SlashCommand = {
	name: string;
	description: string;
};

/**
 * The query the composer text implies, or `null` when the menu should stay
 * closed. `""` means "just typed `/`" — show everything.
 *
 * A space closes the menu: once the user types `/verify ` they've committed
 * to a command and the rest of the line is its argument, not a filter. That
 * also means a genuine sentence starting with "/ " never traps the menu open.
 */
export function slashQuery(input: string): string | null {
	if (!input.startsWith("/")) return null;
	const rest = input.slice(1);
	// Any whitespace ends the command token — the menu's job is done.
	if (/\s/.test(rest)) return null;
	return rest;
}

/**
 * Skills matching `query`, ranked prefix-first then substring, both
 * case-insensitive. Prefix-first matters because the user is typing the
 * name from its start; a substring hit is a useful fallback (`review` →
 * `code-review`) but should never outrank a literal prefix.
 */
export function matchSkills(
	skills: readonly RepoSkill[],
	query: string,
): SlashCommand[] {
	const q = query.toLowerCase();
	const prefix: SlashCommand[] = [];
	const substring: SlashCommand[] = [];
	for (const skill of skills) {
		const name = skill.name.toLowerCase();
		const entry = { name: skill.name, description: skill.description };
		if (name.startsWith(q)) prefix.push(entry);
		else if (q !== "" && name.includes(q)) substring.push(entry);
	}
	return [...prefix, ...substring];
}

/**
 * The composer text after accepting `name`. A trailing space is added so the
 * user can type the request straight after the command — and, because a
 * space closes the menu, that same space is what dismisses it.
 */
export function applySlashCommand(name: string): string {
	return `/${name} `;
}
