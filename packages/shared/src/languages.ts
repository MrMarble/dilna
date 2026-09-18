/**
 * The languages dilna recognizes, and the extensions that identify them.
 *
 * Lives in `packages/shared` because the *name* each side uses is a contract:
 * the server derives language names from file extensions (`repos/languages.ts`
 * feeds `LanguageStat.name`) and the web looks each name up to get a colour
 * and an icon. The web's map carried a comment asserting it matched the
 * server's extension map; it didn't — the server emitted 36 names and the web
 * had 25 keys, so ten languages (Erlang, Clojure, SQL, R, Julia, Nim, OCaml,
 * F#, HCL, Protocol Buffers) rendered as a grey bar with a generic folder
 * icon, indistinguishable from "unrecognised". Typing the web's map as
 * `Record<DilnaLanguage, …>` turns the next missing one into a compile error.
 *
 * Deliberately a small curated list rather than a linguist port: only
 * extensions that clearly identify a programming language count toward the
 * breakdown, so docs, config, lockfiles, images etc. never skew it (GitHub's
 * linguist makes the same call by marking those as documentation/data).
 *
 * Colours and icons stay web-side — they are presentation, not contract.
 */
export const EXTENSION_LANGUAGES = {
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
} as const satisfies Record<string, string>;

/** Every language name the extension map can emit. The union below is derived
 * from it, so the two can't drift. */
export const DILNA_LANGUAGES: readonly DilnaLanguage[] = [
	...new Set(Object.values(EXTENSION_LANGUAGES)),
];

/** A language name dilna can report in a Repo's breakdown. */
export type DilnaLanguage =
	(typeof EXTENSION_LANGUAGES)[keyof typeof EXTENSION_LANGUAGES];

/** The language a file extension identifies, or undefined when it isn't one
 * dilna counts. Case-insensitive, matching how the server reads a path. */
export function languageForExtension(ext: string): DilnaLanguage | undefined {
	return EXTENSION_LANGUAGES[
		ext.toLowerCase() as keyof typeof EXTENSION_LANGUAGES
	];
}
