import type { MessagePart } from "@dilna/shared";
import { describe, expect, it } from "vitest";
import { partsToMarkdown } from "@/lib/message-markdown";

function tool(tool: string, input: unknown): MessagePart {
	return { type: "tool_call", callId: "c1", tool, input, output: null };
}

describe("partsToMarkdown", () => {
	it("returns a text part's markdown source verbatim", () => {
		const md = "1. first\n2. second\n\n- bullet\n\n```js\nconst a = 1;\n```";
		expect(partsToMarkdown([{ type: "text", text: md }])).toBe(md);
	});

	it("joins multiple text parts with a blank line", () => {
		expect(
			partsToMarkdown([
				{ type: "text", text: "one" },
				{ type: "text", text: "two" },
			]),
		).toBe("one\n\ntwo");
	});

	it("drops empty and whitespace-only text parts", () => {
		expect(
			partsToMarkdown([
				{ type: "text", text: "kept" },
				{ type: "text", text: "   \n " },
				{ type: "text", text: "" },
			]),
		).toBe("kept");
	});

	it("summarizes a tool call as a one-line italic note", () => {
		expect(partsToMarkdown([tool("Read", { file_path: "src/a.ts" })])).toBe(
			"_Read src/a.ts_",
		);
	});

	it("omits tool calls when asked for text only", () => {
		const parts: MessagePart[] = [
			{ type: "text", text: "before" },
			tool("Read", { file_path: "src/a.ts" }),
			{ type: "text", text: "after" },
		];
		expect(partsToMarkdown(parts, { includeToolCalls: false })).toBe(
			"before\n\nafter",
		);
	});

	it("keeps text and tool calls in their original order", () => {
		const parts: MessagePart[] = [
			{ type: "text", text: "before" },
			tool("Write", { file_path: "out.txt" }),
			{ type: "text", text: "after" },
		];
		expect(partsToMarkdown(parts)).toBe("before\n\n_Write out.txt_\n\nafter");
	});

	it("survives an unknown tool with an unexpected input shape", () => {
		expect(partsToMarkdown([tool("mcp__weird__thing", null)])).toContain(
			"mcp__weird__thing",
		);
	});

	it("is empty for a message with no renderable parts", () => {
		expect(partsToMarkdown([])).toBe("");
	});
});
