import { type LanguageStat, languageForExtension } from "@dilna/shared";

// The extension→language map lives in `packages/shared` (see languages.ts
// there): the *names* are a contract both sides need, since the web looks each
// one up for a colour and an icon.

/** Generated lockfiles whose extension is otherwise recognized (YAML/JSON
 * variants) — huge and machine-written, they'd dominate the byte share and
 * mislabel e.g. a TypeScript repo as YAML because of pnpm-lock.yaml. */
const IGNORED_BASENAMES = new Set([
	"pnpm-lock.yaml",
	"yarn.lock",
	"package-lock.json",
	"bun.lock",
]);

export type TreeFile = {
	path: string;
	/** Blob size in bytes. */
	size: number;
};

/**
 * GitHub-style language breakdown: byte share per recognized language,
 * descending, percentages rounded to one decimal. Files whose extension
 * isn't in the curated map contribute nothing.
 */
export function languagesFromFiles(files: TreeFile[]): LanguageStat[] {
	const bytesByLanguage = new Map<string, number>();
	let totalBytes = 0;

	for (const file of files) {
		const base = file.path.slice(file.path.lastIndexOf("/") + 1);
		if (IGNORED_BASENAMES.has(base)) continue;
		const dot = base.lastIndexOf(".");
		if (dot <= 0) continue; // no extension, or a dotfile like `.gitignore`
		const language = languageForExtension(base.slice(dot + 1));
		if (!language || file.size <= 0) continue;
		bytesByLanguage.set(
			language,
			(bytesByLanguage.get(language) ?? 0) + file.size,
		);
		totalBytes += file.size;
	}

	if (totalBytes === 0) return [];

	return [...bytesByLanguage.entries()]
		.map(([name, bytes]) => ({
			name,
			pct: Math.round((bytes / totalBytes) * 1000) / 10,
		}))
		.sort((a, b) => b.pct - a.pct);
}
