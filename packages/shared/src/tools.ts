/**
 * The Agent's tool vocabulary, owned here because both sides need it and
 * neither may import the other (ADR-0001).
 *
 * `apps/server` registers these tools (`agents/pi.ts` and the tool modules it
 * pulls in) and passes the *provider's* tool name straight onto the wire as
 * `tool_call_start.tool`. `apps/web` switches on it to pick an icon, a label
 * and a one-line detail. Before this module there were two lists: the server's
 * actual snake_case registrations and the web's switch, which still keyed on
 * the Claude Agent SDK's PascalCase names (`Read`, `Bash`, `WebFetch`) long
 * after the pi migration (ADR-0020) replaced them. Twelve of that switch's
 * fourteen cases were unreachable — every one of dilna's own tools and every
 * built-in fell through to a wrench and a raw `read_repo_memory` string.
 *
 * The missed rename is the shape of the bug this prevents: nothing linked the
 * two lists, so a server-side rename was a green build on both sides. Here the
 * union is the link — `events.ts` narrows `tool` to it, so the server cannot
 * emit a name outside it (it can't *build* one), and the web's
 * `Record<ToolName, …>` cannot lose a case without failing to compile.
 *
 * What deliberately stays web-side: the icons, the labels, and the formatting
 * of a detail line. Those are presentation, not contract. What moves is only
 * the part both packages must agree on — which names exist, and which argument
 * the detail is read from.
 */

/** Every tool name dilna can put on the wire, as a runtime list so tests can
 * enumerate it — the union below is derived from it, so the two can't drift. */
export const TOOL_NAMES = [
	// pi-coding-agent's built-ins, registered in `agents/pi.ts`. Their names
	// are pi's, not Claude's: `read`, not `Read`.
	"read",
	"write",
	"edit",
	"grep",
	"find",
	"ls",
	"bash",
	// dilna's own tools.
	"read_repo_memory",
	"update_repo_memory",
	"read_skill",
	"fetch",
	"task",
	"dilna_publish_artefact",
	"dilna_send_image",
] as const;

/**
 * The tools the Agent can call, as a union. `tool_call_start.tool` is
 * narrowed to this, so a server-side registration the web doesn't know about
 * is a type error rather than an invisible fallback.
 */
export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * The argument each tool's one-line detail is read from, per tool.
 *
 * A map rather than a switch because "which field names a call's subject" is
 * a fact about the *tool*, not about the web's rendering — and because a
 * missing entry is then a compile error at the `Record<ToolName, …>` rather
 * than a silently-undefined detail. The Claude-era switch got this wrong twice
 * over: it keyed on PascalCase names *and* on Claude's argument names
 * (`file_path`, `notebook_path`), so even after fixing the names every detail
 * would have stayed blank.
 *
 * Two tools carry their subject somewhere this map can't express, and are
 * special-cased in the web's renderer instead: `dilna_publish_artefact` falls
 * back from `title` to `path`, and `update_repo_memory`/`read_repo_memory`
 * have no single-line subject at all. They still appear here — `TOOL_ARG_KEYS`
 * is total over `ToolName` — with the field the renderer reaches for first.
 */
export const TOOL_ARG_KEYS: Record<ToolName, string> = {
	read: "path",
	write: "path",
	edit: "path",
	grep: "pattern",
	find: "pattern",
	ls: "path",
	bash: "command",
	read_repo_memory: "repoId",
	update_repo_memory: "content",
	read_skill: "name",
	fetch: "url",
	task: "description",
	dilna_publish_artefact: "title",
	dilna_send_image: "path",
};

/** Whether a wire string names a tool dilna knows. The one runtime narrowing
 * point: a persisted `tool_call` part from an older build, or a name a future
 * server adds before this union catches up, is recognised here. */
export function isToolName(name: string): name is ToolName {
	return (TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * A tool name dilna's build doesn't recognise — an MCP tool, or a name a
 * newer server emitted into a row an older web is reading.
 *
 * Deliberately its own type rather than widening {@link ToolName} to `string`:
 * the web's `Record<ToolName, …>` stays exhaustive over the tools that *must*
 * have an icon, while a renderer still has something to show for the ones
 * that legitimately have no entry. `String & {}` keeps literal-union
 * inference intact (a plain `string` would collapse `ToolName | string` to
 * `string`, defeating the whole narrowing).
 */
export type UnknownToolName = string & { readonly __unknownTool?: never };

/** The wire type: a known tool, or an unrecognised one. */
export type WireToolName = ToolName | UnknownToolName;

/**
 * Narrow a wire string to {@link WireToolName}. Every string qualifies — this
 * is the totality assertion, not a filter: an unknown name is still a name,
 * it just renders with the fallback. Kept as a function so the *intent* of
 * the boundary ("this is where an untrusted string becomes a tool") is
 * visible at each call site rather than buried in a cast.
 */
export function asWireToolName(name: string): WireToolName {
	return name as WireToolName;
}
