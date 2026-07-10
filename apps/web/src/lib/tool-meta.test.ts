import { describe, expect, it } from "vitest";
import { getToolMeta, shortenPath } from "@/lib/tool-meta";

describe("shortenPath", () => {
	it("strips the data-dir prefix through the worktree segment", () => {
		expect(
			shortenPath("/home/u/dilna/data/worktrees/sess-abc/src/index.ts"),
		).toBe("src/index.ts");
	});

	it("returns non-worktree paths unchanged", () => {
		expect(shortenPath("/etc/hosts")).toBe("/etc/hosts");
	});

	it("returns the dir name itself when nothing follows it", () => {
		expect(shortenPath("/data/worktrees/sess-abc")).toBe("sess-abc");
	});
});

describe("getToolMeta", () => {
	it("summarizes file tools by repo-relative path", () => {
		const meta = getToolMeta("Read", {
			file_path: "/data/worktrees/s1/src/app.ts",
		});
		expect(meta.label).toBe("Read");
		expect(meta.detail).toBe("src/app.ts");
	});

	it("summarizes Bash by its command", () => {
		const meta = getToolMeta("Bash", { command: "pnpm test" });
		expect(meta.label).toBe("Bash");
		expect(meta.detail).toBe("pnpm test");
	});

	it("summarizes TodoWrite by completion progress", () => {
		const meta = getToolMeta("TodoWrite", {
			todos: [
				{ content: "a", status: "completed" },
				{ content: "b", status: "in_progress" },
				{ content: "c", status: "pending" },
			],
		});
		expect(meta.detail).toBe("1/3 done");
	});

	it("falls back to the raw tool name with no detail for unknown tools", () => {
		const meta = getToolMeta("mcp__foo__bar", { anything: 1 });
		expect(meta.label).toBe("mcp__foo__bar");
		expect(meta.detail).toBeUndefined();
	});

	it("tolerates malformed input without throwing", () => {
		expect(getToolMeta("Read", null).detail).toBeUndefined();
		expect(getToolMeta("Bash", "not-an-object").detail).toBeUndefined();
		expect(getToolMeta("TodoWrite", { todos: "nope" }).detail).toBeUndefined();
	});
});
