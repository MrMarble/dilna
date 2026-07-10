import {
	SiC,
	SiCplusplus,
	SiCss,
	SiDart,
	SiElixir,
	SiGnubash,
	SiGo,
	SiHaskell,
	SiHtml5,
	SiJavascript,
	SiKotlin,
	SiLua,
	SiOpenjdk,
	SiPhp,
	SiPython,
	SiRuby,
	SiRust,
	SiScala,
	SiSharp,
	SiSvelte,
	SiSwift,
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

/** Names here must match the server's extension map (repos/languages.ts). */
const LANGUAGE_META: Record<string, LanguageMeta> = {
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
	Haskell: { color: "#5e5086", icon: SiHaskell },
	Lua: { color: "#000080", icon: SiLua },
	Zig: { color: "#ec915c", icon: SiZig },
	Scala: { color: "#c22d40", icon: SiScala },
	Shell: { color: "#89e051", icon: SiGnubash },
	HTML: { color: "#e34c26", icon: SiHtml5 },
	CSS: { color: "#563d7c", icon: SiCss },
	Vue: { color: "#41b883", icon: SiVuedotjs },
	Svelte: { color: "#ff3e00", icon: SiSvelte },
	YAML: { color: "#cb171e", icon: SiYaml },
};

const FALLBACK_COLOR = "#8b949e";

export function languageColor(name: string): string {
	return LANGUAGE_META[name]?.color ?? FALLBACK_COLOR;
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
	const meta = language ? LANGUAGE_META[language] : undefined;
	if (!meta?.icon) {
		return <FolderGit2 className={className} />;
	}
	const Icon = meta.icon;
	return <Icon color={meta.color} className={className} />;
}
