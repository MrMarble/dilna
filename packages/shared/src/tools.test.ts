import { describe, expect, it } from "vitest";
import {
	asWireToolName,
	isToolName,
	TOOL_ARG_KEYS,
	TOOL_NAMES,
	type ToolName,
} from "./tools";

describe("TOOL_NAMES", () => {
	it("covers the tools the server registers and the web renders", () => {
		// The set both sides must agree on. A tool added server-side without an
		// entry here is a compile error at the web's `Record<ToolName, …>`; a
		// name here with no server tool is dead weight in that same map.
		expect([...TOOL_NAMES].sort()).toEqual(
			[
				"bash",
				"dilna_publish_artefact",
				"dilna_send_image",
				"edit",
				"fetch",
				"find",
				"grep",
				"ls",
				"read",
				"read_repo_memory",
				"read_skill",
				"task",
				"update_repo_memory",
				"write",
			].sort(),
		);
	});

	it("has no duplicates", () => {
		expect(new Set(TOOL_NAMES).size).toBe(TOOL_NAMES.length);
	});
});

describe("TOOL_ARG_KEYS", () => {
	it("names the argument each tool's detail line is read from", () => {
		// One key per tool: the web renders a one-line summary off it, so a
		// missing or wrong key silently blanks the detail (the exact bug the
		// Claude-era switch shipped — its keys were `file_path`, not `path`).
		expect(TOOL_ARG_KEYS.read).toBe("path");
		expect(TOOL_ARG_KEYS.write).toBe("path");
		expect(TOOL_ARG_KEYS.edit).toBe("path");
		expect(TOOL_ARG_KEYS.ls).toBe("path");
		expect(TOOL_ARG_KEYS.bash).toBe("command");
		expect(TOOL_ARG_KEYS.grep).toBe("pattern");
		expect(TOOL_ARG_KEYS.find).toBe("pattern");
		expect(TOOL_ARG_KEYS.fetch).toBe("url");
		expect(TOOL_ARG_KEYS.task).toBe("description");
		expect(TOOL_ARG_KEYS.dilna_publish_artefact).toBe("title");
		expect(TOOL_ARG_KEYS.dilna_send_image).toBe("path");
		expect(TOOL_ARG_KEYS.read_skill).toBe("name");
	});

	it("keys every tool name", () => {
		for (const name of TOOL_NAMES) {
			expect(TOOL_ARG_KEYS[name]).toBeTruthy();
		}
	});

	it("is typed over ToolName, so an unknown name has no key", () => {
		// Compile-time assertion: `TOOL_ARG_KEYS` is a total Record over the
		// union, so indexing it with a non-tool is a type error.
		const name: ToolName = "read";
		expect(TOOL_ARG_KEYS[name]).toBe("path");
	});
});

describe("isToolName", () => {
	it("recognises a registered tool", () => {
		expect(isToolName("read_repo_memory")).toBe(true);
	});

	it("rejects a name dilna doesn't register", () => {
		expect(isToolName("mcp__foo__bar")).toBe(false);
		expect(isToolName("Read")).toBe(false);
	});
});

describe("asWireToolName", () => {
	it("passes any string through, known or not", () => {
		// The wire type admits an unknown tool so the renderer can fall back on
		// it; this is the boundary cast, not a filter.
		expect(asWireToolName("read")).toBe("read");
		expect(asWireToolName("mcp__foo__bar")).toBe("mcp__foo__bar");
	});
});
