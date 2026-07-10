import type { LanguageStat } from "@dilna/shared";

/**
 * Extension → language map for the repo stats endpoint. Deliberately a small
 * curated list rather than a linguist port: only extensions that clearly
 * identify a programming language count toward the breakdown, so docs,
 * config, lockfiles, images etc. never skew it (GitHub's linguist makes the
 * same call by marking those as documentation/data).
 */
const EXTENSION_LANGUAGES: Record<string, string> = {
	ts: "TypeScript",
	tsx: "TypeScript",
	mts: "TypeScript",
	cts: "TypeScript",
	js: "JavaScript",
	jsx: "JavaScript",
	mjs: "JavaScript",
	cjs: "JavaScript",
	py: "Python",
	rs: "Rust",
	go: "Go",
	rb: "Ruby",
	php: "PHP",
	java: "Java",
	c: "C",
	h: "C",
	cc: "C++",
	cpp: "C++",
	cxx: "C++",
	hpp: "C++",
	cs: "C#",
	swift: "Swift",
	kt: "Kotlin",
	kts: "Kotlin",
	dart: "Dart",
	ex: "Elixir",
	exs: "Elixir",
	erl: "Erlang",
	hs: "Haskell",
	lua: "Lua",
	zig: "Zig",
	scala: "Scala",
	clj: "Clojure",
	sh: "Shell",
	bash: "Shell",
	zsh: "Shell",
	fish: "Shell",
	html: "HTML",
	css: "CSS",
	scss: "CSS",
	less: "CSS",
	vue: "Vue",
	svelte: "Svelte",
	sql: "SQL",
	r: "R",
	jl: "Julia",
	nim: "Nim",
	ml: "OCaml",
	fs: "F#",
	tf: "HCL",
	proto: "Protocol Buffers",
	yaml: "YAML",
	yml: "YAML",
};

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
		const language = EXTENSION_LANGUAGES[base.slice(dot + 1).toLowerCase()];
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
