import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hashlineTag } from "./hashlineTag";
import {
	createHashlineEditTool,
	createHashlineReadTool,
} from "./hashlineTools";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "dilna-hashline-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** Run a tool's execute and return its text output. The tool signature's
 * later args (signal, onUpdate, ctx) are unused by these tools. */
async function runTool(
	tool: { execute: (...args: never[]) => Promise<{ content: unknown }> },
	args: Record<string, unknown>,
): Promise<string> {
	const result = (await (
		tool.execute as unknown as (
			id: string,
			args: unknown,
		) => Promise<{ content: { type: string; text: string }[] }>
	)("call-1", args)) as { content: { type: string; text: string }[] };
	return result.content.map((c) => c.text).join("\n");
}

describe("hashline read tool", () => {
	it("returns the file tagged and numbered", async () => {
		writeFileSync(join(dir, "a.ts"), "one\ntwo\n");
		const tool = createHashlineReadTool(dir);

		const out = await runTool(tool, { path: "a.ts" });

		expect(out).toContain(`[a.ts#${hashlineTag("one\ntwo\n")}]`);
		expect(out).toContain("1:one");
		expect(out).toContain("2:two");
	});

	it("honours offset and limit while keeping real line numbers", async () => {
		writeFileSync(join(dir, "a.ts"), "1\n2\n3\n4\n5\n");
		const tool = createHashlineReadTool(dir);

		const out = await runTool(tool, { path: "a.ts", offset: 3, limit: 2 });

		expect(out).toContain("3:3");
		expect(out).toContain("4:4");
		expect(out).not.toContain("5:5");
	});

	it("reports a missing file as an error rather than empty content", async () => {
		const tool = createHashlineReadTool(dir);

		await expect(runTool(tool, { path: "nope.ts" })).rejects.toThrow();
	});
});

describe("hashline edit tool", () => {
	it("applies a patch and writes it to disk", async () => {
		const path = join(dir, "a.ts");
		writeFileSync(path, "const a = 1;\nconst b = 2;\n");
		const tool = createHashlineEditTool(dir);

		const out = await runTool(tool, {
			path: "a.ts",
			tag: hashlineTag("const a = 1;\nconst b = 2;\n"),
			patch: "PUT 1.=1:\n+const a = 42;",
		});

		expect(readFileSync(path, "utf8")).toBe("const a = 42;\nconst b = 2;\n");
		// The result carries the new tag so a chained edit needs no re-read.
		expect(out).toContain(
			`[a.ts#${hashlineTag("const a = 42;\nconst b = 2;\n")}]`,
		);
	});

	it("refuses a stale tag, leaves the file untouched, and names the current tag", async () => {
		const path = join(dir, "a.ts");
		const original = "const a = 1;\n";
		writeFileSync(path, original);
		const tool = createHashlineEditTool(dir);

		const out = await runTool(tool, {
			path: "a.ts",
			tag: "0000",
			patch: "PUT 1.=1:\n+const a = 42;",
		});

		expect(readFileSync(path, "utf8")).toBe(original);
		expect(out).toContain(hashlineTag(original));
		expect(out.toLowerCase()).toContain("changed");
	});

	it("refuses a stale tag without creating the file when it doesn't exist", async () => {
		const tool = createHashlineEditTool(dir);

		await runTool(tool, {
			path: "new.ts",
			tag: "0000",
			patch: "PUT 1.=1:\n+x",
		});

		// An edit must never create a file — that's `write`'s job, and a
		// created file would bypass every anchor guarantee.
		expect(() => readFileSync(join(dir, "new.ts"), "utf8")).toThrow();
	});
});
