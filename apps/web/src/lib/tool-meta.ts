import { isToolName, TOOL_ARG_KEYS, type ToolName } from "@dilna/shared";
import {
	Bot,
	FileOutput,
	FilePen,
	FilePlus,
	FileText,
	FolderSearch,
	Globe,
	Image,
	SearchCode,
	SquareTerminal,
	Wrench,
} from "lucide-react";

export type ToolMeta = {
	icon: typeof Wrench;
	label: string;
	/** One-line summary of the call's input (path, command, pattern…). */
	detail?: string;
};

/**
 * Trim a worktree-absolute path down to the repo-relative part for display.
 * SessionView deliberately doesn't expose the worktree path (internal
 * plumbing), so this is a heuristic on dilna's on-disk layout
 * (`<dataDir>/worktrees/<dirName>/…`) — callers keep the full path in a
 * hover title as the fallback.
 */
export function shortenPath(p: string): string {
	const marker = "/worktrees/";
	const at = p.indexOf(marker);
	if (at === -1) return p;
	const rest = p.slice(at + marker.length);
	const slash = rest.indexOf("/");
	return slash === -1 ? rest : rest.slice(slash + 1);
}

function str(obj: Record<string, unknown>, key: string): string | undefined {
	const v = obj[key];
	return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Presentation for each of dilna's tools: icon and human label. The *name set
 * and its argument key* come from `@dilna/shared` (`tools.ts`) — this map only
 * adds what is genuinely web-only.
 *
 * Typed `Record<ToolName, …>`, so adding a tool to the shared union without an
 * icon here is a compile error. That is deliberately the opposite of the
 * switch this replaced: a `default:` case swallowed every missing tool, so the
 * pi migration (ADR-0020) renamed all the server's tools and left twelve
 * unreachable `case "Read":`-style branches rendering as a bare wrench — a
 * green build on both sides and a broken UI.
 *
 * `detail` is a key into the call's input, or a function of it for the two
 * tools whose one-line summary isn't a single field.
 */
const TOOL_META: Record<
	ToolName,
	{
		icon: typeof Wrench;
		label: string;
		detail: (input: unknown) => string | undefined;
	}
> = {
	read: {
		icon: FileText,
		label: "Read",
		detail: (input) => shortDetail(input, TOOL_ARG_KEYS.read),
	},
	write: {
		icon: FilePlus,
		label: "Write",
		detail: (input) => shortDetail(input, TOOL_ARG_KEYS.write),
	},
	edit: {
		icon: FilePen,
		label: "Edit",
		detail: (input) => shortDetail(input, TOOL_ARG_KEYS.edit),
	},
	grep: {
		icon: SearchCode,
		label: "Grep",
		detail: (input) => str(asObj(input), TOOL_ARG_KEYS.grep),
	},
	find: {
		icon: FolderSearch,
		label: "Find",
		detail: (input) => str(asObj(input), TOOL_ARG_KEYS.find),
	},
	ls: {
		icon: FolderSearch,
		label: "List",
		detail: (input) => shortDetail(input, TOOL_ARG_KEYS.ls),
	},
	bash: {
		icon: SquareTerminal,
		label: "Bash",
		detail: (input) => str(asObj(input), TOOL_ARG_KEYS.bash),
	},
	read_repo_memory: {
		icon: FileText,
		label: "Read memory",
		detail: () => undefined,
	},
	update_repo_memory: {
		icon: FilePen,
		label: "Update memory",
		detail: () => undefined,
	},
	read_skill: {
		icon: FileText,
		label: "Read skill",
		detail: (input) => str(asObj(input), TOOL_ARG_KEYS.read_skill),
	},
	fetch: {
		icon: Globe,
		label: "Fetch",
		detail: (input) => str(asObj(input), TOOL_ARG_KEYS.fetch),
	},
	task: {
		icon: Bot,
		label: "Task",
		detail: (input) => str(asObj(input), TOOL_ARG_KEYS.task),
	},
	// dilna's own publish tool (issue #194). Titled by what the user will see
	// in the Artefacts panel, falling back to the path when the Agent
	// published without a title.
	dilna_publish_artefact: {
		icon: FileOutput,
		label: "Publish",
		detail: (input) =>
			str(asObj(input), TOOL_ARG_KEYS.dilna_publish_artefact) ??
			shortDetail(input, "path"),
	},
	// dilna's own image tool (issue #222). Detailed by the path rather than the
	// caption: the caption is already rendered as prose next to the picture, so
	// repeating it on the collapsed card says nothing new.
	dilna_send_image: {
		icon: Image,
		label: "Send image",
		detail: (input) => shortDetail(input, TOOL_ARG_KEYS.dilna_send_image),
	},
};

function asObj(input: unknown): Record<string, unknown> {
	return (input !== null && typeof input === "object" ? input : {}) as Record<
		string,
		unknown
	>;
}

/**
 * Per-tool display metadata. A tool dilna knows gets its own icon, label and
 * detail; a tool it doesn't (an MCP tool, or a name a newer server emitted) —
 * or a persisted part from a build whose vocabulary differs — falls back to a
 * wrench with the raw name, exactly as before. Never throws on unexpected
 * input shapes.
 */
export function getToolMeta(tool: string, input: unknown): ToolMeta {
	if (isToolName(tool)) {
		const meta = TOOL_META[tool];
		return { icon: meta.icon, label: meta.label, detail: meta.detail(input) };
	}
	return { icon: Wrench, label: tool, detail: undefined };
}

function shortDetail(input: unknown, key: string): string | undefined {
	const v = str(asObj(input), key);
	return v === undefined ? undefined : shortenPath(v);
}
