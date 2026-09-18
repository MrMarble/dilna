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
	// The names here are the ones the *server* registers (pi-coding-agent's
	// `read`/`bash`/…, not Claude's `Read`/`Bash`/…). The previous suite keyed
	// on Claude's names, so it passed while every one of these calls fell
	// through to the wrench fallback in production.
	it("summarizes file tools by repo-relative path", () => {
		const meta = getToolMeta("read", {
			path: "/data/worktrees/s1/src/app.ts",
		});
		expect(meta.label).toBe("Read");
		expect(meta.detail).toBe("src/app.ts");
	});

	it("summarizes Bash by its command", () => {
		const meta = getToolMeta("bash", { command: "pnpm test" });
		expect(meta.label).toBe("Bash");
		expect(meta.detail).toBe("pnpm test");
	});

	it("summarizes grep by its pattern", () => {
		const meta = getToolMeta("grep", { pattern: "TODO" });
		expect(meta.label).toBe("Grep");
		expect(meta.detail).toBe("TODO");
	});

	it("summarizes the fetch tool by its URL", () => {
		expect(getToolMeta("fetch", { url: "https://example.com" }).detail).toBe(
			"https://example.com",
		);
	});

	it("summarizes an Agent-sent image by its path", () => {
		const meta = getToolMeta("dilna_send_image", {
			path: "/data/worktrees/s1/shot.png",
		});
		expect(meta.label).toBe("Send image");
		expect(meta.detail).toBe("shot.png");
	});

	it("labels an artefact publish by its title, falling back to the path", () => {
		expect(
			getToolMeta("dilna_publish_artefact", { title: "Coverage report" })
				.detail,
		).toBe("Coverage report");
		expect(
			getToolMeta("dilna_publish_artefact", {
				path: "/data/worktrees/s1/report.html",
			}).detail,
		).toBe("report.html");
	});

	it("falls back to the raw tool name with no detail for unknown tools", () => {
		const meta = getToolMeta("mcp__foo__bar", { anything: 1 });
		expect(meta.label).toBe("mcp__foo__bar");
		expect(meta.detail).toBeUndefined();
	});

	it("tolerates malformed input without throwing", () => {
		expect(getToolMeta("read", null).detail).toBeUndefined();
		expect(getToolMeta("bash", "not-an-object").detail).toBeUndefined();
		expect(getToolMeta("grep", { pattern: 42 }).detail).toBeUndefined();
	});
});
