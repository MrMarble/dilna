import type { DilnaLanguage } from "@dilna/shared";
import {
	SiC,
	SiClojure,
	SiCplusplus,
	SiCss,
	SiDart,
	SiElixir,
	SiErlang,
	SiFsharp,
	SiGnubash,
	SiGo,
	SiHaskell,
	SiHtml5,
	SiJavascript,
	SiJulia,
	SiKotlin,
	SiLua,
	SiMysql,
	SiNim,
	SiOcaml,
	SiOpenjdk,
	SiPhp,
	SiPython,
	SiR,
	SiRuby,
	SiRust,
	SiScala,
	SiSharp,
	SiSvelte,
	SiSwift,
	SiTerraform,
	SiTypescript,
	SiVuedotjs,
	SiYaml,
	SiZig,
} from "@icons-pack/react-simple-icons";
import { FolderGit2 } from "lucide-react";

type LanguageMeta = {
	/** GitHub linguist's color for the language — used for breakdown bars
	 * and as the icon tint (Simple Icons brand colors like JS yellow can be
	 * unreadable on light surfaces; linguist colors are curated for chips). */
	color: string;
	icon?: typeof SiTypescript;
};

/** Colours and icons per language — the part of the language vocabulary that
 * is genuinely web-only.
 *
 * Typed as a total `Record<DilnaLanguage, …>`, where `DilnaLanguage` is the
 * name union the shared extension map can emit (see
 * `packages/shared/src/languages.ts`). That totality is the point: this map
 * used to be a loose `Record<string, …>` with a comment asserting it matched
 * the server's, and it didn't — ten names the server emits had no entry, so a
 * Clojure or Erlang repo rendered grey and iconless, indistinguishable from an
 * unrecognised language. A new extension added server-side now fails to
 * compile here until it has a colour. */
const LANGUAGE_META: Record<DilnaLanguage, LanguageMeta> = {
	TypeScript: { color: "#3178c6", icon: SiTypescript },
	JavaScript: { color: "#f1e05a", icon: SiJavascript },
	Python: { color: "#3572A5", icon: SiPython },
	Rust: { color: "#dea584", icon: SiRust },
	Go: { color: "#00ADD8", icon: SiGo },
	Ruby: { color: "#701516", icon: SiRuby },
	PHP: { color: "#4F5D95", icon: SiPhp },
	Java: { color: "#b07219", icon: SiOpenjdk },
	C: { color: "#555555", icon: SiC },
	"C++": { color: "#f34b7d", icon: SiCplusplus },
	"C#": { color: "#178600", icon: SiSharp },
	Swift: { color: "#F05138", icon: SiSwift },
	Kotlin: { color: "#A97BFF", icon: SiKotlin },
	Dart: { color: "#00B4AB", icon: SiDart },
	Elixir: { color: "#6e4a7e", icon: SiElixir },
	Erlang: { color: "#B83998", icon: SiErlang },
	Haskell: { color: "#5e5086", icon: SiHaskell },
	Lua: { color: "#000080", icon: SiLua },
	Zig: { color: "#ec915c", icon: SiZig },
	Scala: { color: "#c22d40", icon: SiScala },
	Clojure: { color: "#db5855", icon: SiClojure },
	Shell: { color: "#89e051", icon: SiGnubash },
	HTML: { color: "#e34c26", icon: SiHtml5 },
	CSS: { color: "#563d7c", icon: SiCss },
	Vue: { color: "#41b883", icon: SiVuedotjs },
	Svelte: { color: "#ff3e00", icon: SiSvelte },
	SQL: { color: "#e38c00", icon: SiMysql },
	R: { color: "#198CE7", icon: SiR },
	Julia: { color: "#a270ba", icon: SiJulia },
	Nim: { color: "#ffc200", icon: SiNim },
	OCaml: { color: "#ef7a08", icon: SiOcaml },
	"F#": { color: "#b845fc", icon: SiFsharp },
	HCL: { color: "#844FBA", icon: SiTerraform },
	// No logo in simple-icons; the colour alone distinguishes it from the
	// unrecognised-language grey, and the folder fallback icon renders.
	"Protocol Buffers": { color: "#4A8D8D" },
	YAML: { color: "#cb171e", icon: SiYaml },
};

const FALLBACK_COLOR = "#8b949e";

/** Look up a name that arrived as a plain string (a `LanguageStat.name`, which
 * the wire carries as `string`). A name outside the union — a Repo counted by
 * a newer server, or a stale persisted stat — has no entry and falls back to
 * the neutral colour and folder icon. */
function metaFor(name: string | undefined): LanguageMeta | undefined {
	return name && name in LANGUAGE_META
		? LANGUAGE_META[name as DilnaLanguage]
		: undefined;
}

export function languageColor(name: string): string {
	return metaFor(name)?.color ?? FALLBACK_COLOR;
}

/**
 * Icon for a Repo's primary language, tinted with the language color —
 * GitHub-style variety for the sidebar. Falls back to the generic repo
 * folder icon when the language is unknown or has no logo.
 */
export function LanguageIcon({
	language,
	className,
}: {
	language: string | undefined;
	className?: string;
}) {
	const meta = metaFor(language);
	if (!meta?.icon) {
		return <FolderGit2 className={className} />;
	}
	const Icon = meta.icon;
	return <Icon color={meta.color} className={className} />;
}
