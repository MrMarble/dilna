/**
 * Reversible codec for a skill id (`{source}/{slug}`) into a URL path
 * segment containing no `/` at all — not even percent-encoded.
 *
 * A prior version sent the id as one path segment via `encodeURIComponent`
 * (`%2F` for each `/`). That's correct HTTP, but an edge in front of a
 * deployment (a reverse proxy, tunnel, or CDN doing URL path
 * canonicalization) can decode `%2F` back to a literal `/` and 307-redirect
 * to the "cleaned" URL before the request ever reaches dilna — confirmed via
 * a HAR capture showing exactly that redirect in a real deployment. Base64url
 * (`A-Za-z0-9-_`, no padding) has no `/` or `%` in its alphabet, so there's
 * nothing left for an intermediary to "clean" — the fix works regardless of
 * what's in front of the deployment. `atob`/`btoa`/`TextEncoder`/
 * `TextDecoder` are all global in both the browser and Node (18+), so this
 * needs no environment branch to run on both sides.
 */
export function encodeSkillId(id: string): string {
	const bytes = new TextEncoder().encode(id);
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/** Inverse of {@link encodeSkillId}. */
export function decodeSkillId(encoded: string): string {
	const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
	const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return new TextDecoder().decode(bytes);
}

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
