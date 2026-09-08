import { gunzipSync } from "node:zlib";

/**
 * Talking to skills.sh (issue #60), and unpacking a skill's folder out of its
 * source repo.
 *
 * Two things forced this shape, both verified against the live service:
 *
 * 1. **The documented `/api/v1/*` API is unusable here.** It authenticates
 *    with a *Vercel OIDC token* — minted per-request for apps deployed on
 *    Vercel — and returns 401 `authentication_required` without one. A
 *    self-hosted dilna has no way to mint one, so the otherwise-ideal
 *    `/api/v1/skills/{source}/{slug}` (which returns the whole file tree
 *    inline as `{path, contents}[]`) is off the table. The *legacy*
 *    `/api/search` endpoint — the one `vercel-labs/skills`' own CLI calls —
 *    needs no auth and is what `searchSkills` uses.
 *
 * 2. **Skills are folders, not single files.** `mattpocock/skills/tdd` is
 *    `SKILL.md` plus `tests.md`, `mocking.md` and `agents/openai.yaml`, and
 *    SKILL.md links to those siblings by relative path — fetching only the
 *    SKILL.md would install a skill with dangling links. So installation
 *    copies the whole directory, which is also how `npx skills add` does it:
 *    it never uses the registry API for content at all, it downloads the
 *    source repo's tarball from codeload and extracts the subfolder.
 *
 * dilna does the same (no auth needed, no dependency on the `skills` package
 * — which is CLI-only and exports nothing importable). The tar reading is
 * hand-rolled against `node:zlib` rather than adding a `tar` dependency: the
 * format is 512-byte headers plus padded content, and doing it here keeps the
 * hostile-archive checks (below) visible instead of trusting a library's
 * defaults.
 */

/** Skills.sh's unauthenticated legacy search endpoint (what `npx skills`
 * itself calls). Overridable for tests. */
const SKILLS_API_BASE = process.env.DILNA_SKILLS_API_URL ?? "https://skills.sh";

/**
 * Caps on a downloaded archive, mirroring the ones `vercel-labs/skills`
 * applies in its own `download-source.ts`. A skill is a handful of markdown
 * files; these bounds exist so a hostile or accidentally-huge source repo
 * can't exhaust memory or disk on a self-hosted box.
 */
const DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;
const EXTRACT_MAX_BYTES = 25 * 1024 * 1024;
const EXTRACT_MAX_FILES = 1000;
const FETCH_TIMEOUT_MS = 30_000;

/** One search hit, narrowed to what the install UI actually renders. */
export type SkillSearchResult = {
	/** `{source}/{slug}` — stable, and the id dilna stores. */
	id: string;
	name: string;
	source: string;
	slug: string;
	installs: number;
};

type LegacySearchResponse = {
	skills?: Array<{
		id?: unknown;
		skillId?: unknown;
		name?: unknown;
		source?: unknown;
		installs?: unknown;
	}>;
};

async function fetchWithTimeout(
	url: string,
	init?: RequestInit,
): Promise<Response> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Search the skills.sh catalog. Returns `[]` rather than throwing when the
 * registry is unreachable or answers with an unexpected shape — search is a
 * discovery aid layered over "paste a URL", so a registry outage should
 * degrade the page, not break installing by URL.
 */
export async function searchSkills(
	query: string,
	owner?: string,
): Promise<SkillSearchResult[]> {
	const trimmed = query.trim();
	if (trimmed.length < 2) return [];

	const url = new URL("/api/search", SKILLS_API_BASE);
	url.searchParams.set("q", trimmed);
	if (owner) url.searchParams.set("owner", owner);

	let body: LegacySearchResponse;
	try {
		const res = await fetchWithTimeout(url.toString());
		if (!res.ok) return [];
		body = (await res.json()) as LegacySearchResponse;
	} catch {
		return [];
	}

	if (!Array.isArray(body.skills)) return [];
	const results: SkillSearchResult[] = [];
	for (const raw of body.skills) {
		if (typeof raw?.id !== "string" || typeof raw.source !== "string") continue;
		const slug =
			typeof raw.skillId === "string" && raw.skillId
				? raw.skillId
				: raw.id.slice(raw.source.length + 1);
		if (!slug) continue;
		results.push({
			id: raw.id,
			name: typeof raw.name === "string" && raw.name ? raw.name : slug,
			source: raw.source,
			slug,
			installs: typeof raw.installs === "number" ? raw.installs : 0,
		});
	}
	return results;
}

/** A skill's files, keyed by path relative to the skill's own folder. */
export type SkillFiles = Map<string, Buffer>;

export type ResolvedSource = {
	/** GitHub `owner/repo`. */
	repo: string;
	/** Skill folder name to look for inside the repo, when known. */
	skill?: string;
};

/**
 * Parse the things a user might paste into the "install by URL" field into a
 * GitHub repo (+ optional skill folder):
 *
 *   https://www.skills.sh/mattpocock/skills/tdd   → mattpocock/skills, tdd
 *   https://github.com/mattpocock/skills          → mattpocock/skills
 *   https://github.com/o/r/tree/main/skills/x     → o/r, x
 *   mattpocock/skills/tdd                         → mattpocock/skills, tdd
 *
 * Returns null for anything else — dilna only installs from GitHub sources
 * today, matching where the registry's own content lives.
 */
export function parseSkillSource(input: string): ResolvedSource | null {
	const trimmed = input.trim().replace(/\/+$/, "");
	if (!trimmed) return null;

	let host: string | null = null;
	let pathParts: string[];

	if (/^https?:\/\//i.test(trimmed)) {
		let url: URL;
		try {
			url = new URL(trimmed);
		} catch {
			return null;
		}
		host = url.hostname.replace(/^www\./, "");
		pathParts = url.pathname.split("/").filter(Boolean);
	} else {
		pathParts = trimmed.split("/").filter(Boolean);
	}

	if (host && host !== "skills.sh" && host !== "github.com") return null;

	// github.com/<owner>/<repo>/tree/<ref>/<path...> — the skill is the last
	// path segment.
	if (host === "github.com" && pathParts[2] === "tree") {
		const [owner, repo] = pathParts;
		if (!owner || !repo) return null;
		const sub = pathParts.slice(4);
		const last = sub.at(-1);
		return {
			repo: `${owner}/${repo.replace(/\.git$/, "")}`,
			...(last ? { skill: last } : {}),
		};
	}

	const [owner, repo, skill] = pathParts;
	if (!owner || !repo) return null;
	return {
		repo: `${owner}/${repo.replace(/\.git$/, "")}`,
		...(skill ? { skill } : {}),
	};
}

type TarEntry = { path: string; body: Buffer };

/**
 * Minimal tar reader: 512-byte header blocks, name at offset 0, size at 124
 * (octal), type flag at 156, content padded to a 512-byte boundary. Handles
 * the GNU/POSIX long-name entries (`L`/`x`) real GitHub tarballs contain for
 * deep paths, and skips everything that isn't a regular file.
 */
function readTar(buf: Buffer): TarEntry[] {
	const entries: TarEntry[] = [];
	let offset = 0;
	let longName: string | null = null;
	let bytes = 0;

	while (offset + 512 <= buf.length) {
		const header = buf.subarray(offset, offset + 512);
		// Two consecutive zero blocks mark the end of the archive.
		if (header.every((b) => b === 0)) break;

		const rawName = header
			.subarray(0, 100)
			.toString("utf8")
			.replace(/\0.*$/, "");
		const sizeField = header
			.subarray(124, 136)
			.toString("utf8")
			.replace(/\0.*$/, "")
			.trim();
		const size = Number.parseInt(sizeField, 8);
		if (!Number.isFinite(size) || size < 0) break;
		const typeFlag = String.fromCharCode(header[156] ?? 0);

		const contentStart = offset + 512;
		const content = buf.subarray(contentStart, contentStart + size);
		offset = contentStart + Math.ceil(size / 512) * 512;

		// GNU long name / POSIX extended header: the *next* entry's real path.
		if (typeFlag === "L") {
			longName = content.toString("utf8").replace(/\0.*$/, "");
			continue;
		}
		if (typeFlag === "x" || typeFlag === "g") {
			const match = content.toString("utf8").match(/\d+ path=([^\n]+)\n/);
			if (match?.[1]) longName = match[1];
			continue;
		}

		const name = longName ?? rawName;
		longName = null;

		// Regular files only ("0" or NUL); directories, symlinks and hardlinks
		// are skipped — a skill is markdown, and following links out of the
		// archive is exactly the class of thing to refuse.
		if (typeFlag !== "0" && typeFlag !== "\0") continue;

		entries.push({ path: name, body: Buffer.from(content) });

		bytes += size;
		if (bytes > EXTRACT_MAX_BYTES)
			throw new Error("Skill archive is too large to extract.");
		if (entries.length > EXTRACT_MAX_FILES)
			throw new Error("Skill archive contains too many files.");
	}

	return entries;
}

/** Reject absolute paths, drive letters and any `..` traversal (zip-slip). */
function isSafeRelativePath(p: string): boolean {
	if (!p || p.startsWith("/") || /^[a-zA-Z]:/.test(p)) return false;
	return !p.split("/").includes("..");
}

/**
 * Download `owner/repo`'s tarball and return the files of the one skill
 * folder inside it, keyed relative to that folder (`SKILL.md`,
 * `agents/openai.yaml`, ...).
 *
 * When `skill` is given, the folder whose basename matches it and which
 * contains a `SKILL.md` wins; otherwise a repo with exactly one `SKILL.md`
 * installs that one, and an ambiguous repo is an error naming the candidates
 * (rather than picking arbitrarily).
 */
export async function fetchSkillFiles(
	source: ResolvedSource,
	ref = "HEAD",
): Promise<{ files: SkillFiles; skillDir: string }> {
	const url = `https://codeload.github.com/${source.repo}/tar.gz/${ref}`;
	const res = await fetchWithTimeout(url);
	if (!res.ok) {
		throw new Error(
			`Could not download ${source.repo} from GitHub (HTTP ${res.status}). Check the URL is a public repository.`,
		);
	}

	const raw = Buffer.from(await res.arrayBuffer());
	if (raw.length > DOWNLOAD_MAX_BYTES)
		throw new Error("Skill source archive is too large to download.");

	const entries = readTar(gunzipSync(raw));

	// GitHub tarballs nest everything under a single `<repo>-<ref>/` dir.
	const stripped = entries
		.map((e) => ({ ...e, path: e.path.split("/").slice(1).join("/") }))
		.filter((e) => isSafeRelativePath(e.path));

	const skillMds = stripped.filter(
		(e) => e.path === "SKILL.md" || e.path.endsWith("/SKILL.md"),
	);
	if (skillMds.length === 0)
		throw new Error(`No SKILL.md found in ${source.repo}.`);

	const dirOf = (p: string) =>
		p.slice(0, Math.max(0, p.length - "SKILL.md".length - 1));

	let skillDir: string | undefined;
	if (source.skill) {
		const wanted = skillMds.find((e) => {
			const dir = dirOf(e.path);
			return dir.split("/").at(-1) === source.skill;
		});
		if (!wanted)
			throw new Error(
				`No skill named "${source.skill}" found in ${source.repo}.`,
			);
		skillDir = dirOf(wanted.path);
	} else if (skillMds.length === 1 && skillMds[0]) {
		skillDir = dirOf(skillMds[0].path);
	} else {
		const names = skillMds
			.map((e) => dirOf(e.path).split("/").at(-1))
			.filter(Boolean)
			.slice(0, 10);
		throw new Error(
			`${source.repo} contains ${skillMds.length} skills (${names.join(", ")}${
				skillMds.length > names.length ? ", ..." : ""
			}). Point at a single skill, e.g. https://www.skills.sh/${source.repo}/<skill>.`,
		);
	}

	const prefix = skillDir ? `${skillDir}/` : "";
	const files: SkillFiles = new Map();
	for (const entry of stripped) {
		if (prefix && !entry.path.startsWith(prefix)) continue;
		const rel = prefix ? entry.path.slice(prefix.length) : entry.path;
		// Only the skill's own folder — not nested sibling skills.
		if (!rel || (rel.includes("/SKILL.md") && rel !== "SKILL.md")) continue;
		files.set(rel, entry.body);
	}

	if (!files.has("SKILL.md"))
		throw new Error(`No SKILL.md found in ${source.repo}.`);

	return { files, skillDir: skillDir ?? "" };
}
