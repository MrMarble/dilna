import {
	Bot,
	FilePen,
	FilePlus,
	FileText,
	FolderSearch,
	Globe,
	ListTodo,
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

function todoDetail(todos: unknown): string | undefined {
	if (!Array.isArray(todos) || todos.length === 0) return undefined;
	const done = todos.filter(
		(t) =>
			t !== null &&
			typeof t === "object" &&
			(t as { status?: unknown }).status === "completed",
	).length;
	return `${done}/${todos.length} done`;
}

/**
 * Per-tool display metadata for the Claude agent's built-in tool names.
 * Unknown tools (MCP tools, future additions) fall back to a wrench icon
 * with the raw tool name — never throws on unexpected input shapes.
 */
export function getToolMeta(tool: string, input: unknown): ToolMeta {
	const obj = (
		input !== null && typeof input === "object" ? input : {}
	) as Record<string, unknown>;

	switch (tool) {
		case "Read":
			return {
				icon: FileText,
				label: "Read",
				detail: shortDetail(obj, "file_path"),
			};
		case "Edit":
		case "MultiEdit":
			return {
				icon: FilePen,
				label: "Edit",
				detail: shortDetail(obj, "file_path"),
			};
		case "Write":
			return {
				icon: FilePlus,
				label: "Write",
				detail: shortDetail(obj, "file_path"),
			};
		case "NotebookEdit":
			return {
				icon: FilePen,
				label: "Notebook",
				detail: shortDetail(obj, "notebook_path"),
			};
		case "Bash":
			return {
				icon: SquareTerminal,
				label: "Bash",
				detail: str(obj, "command"),
			};
		case "Grep":
			return { icon: SearchCode, label: "Grep", detail: str(obj, "pattern") };
		case "Glob":
			return { icon: FolderSearch, label: "Glob", detail: str(obj, "pattern") };
		case "WebFetch":
			return { icon: Globe, label: "Fetch", detail: str(obj, "url") };
		case "WebSearch":
			return { icon: Globe, label: "Search", detail: str(obj, "query") };
		case "Task":
			return { icon: Bot, label: "Task", detail: str(obj, "description") };
		case "TodoWrite":
			return { icon: ListTodo, label: "Todos", detail: todoDetail(obj.todos) };
		default:
			return { icon: Wrench, label: tool };
	}
}

function shortDetail(
	obj: Record<string, unknown>,
	key: string,
): string | undefined {
	const v = str(obj, key);
	return v === undefined ? undefined : shortenPath(v);
}
