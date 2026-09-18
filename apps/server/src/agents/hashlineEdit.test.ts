import { describe, expect, it } from "vitest";
import { applyHashline, formatPatchResult } from "./hashlineEdit";
import { hashlineTag } from "./hashlineTag";

/** Shorthand: apply a patch to `text`, asserting it wasn't refused. */
function apply(text: string, patch: string, tag = hashlineTag(text)): string {
	const result = applyHashline({ text, tag, patch });
	if (!result.ok) {
		throw new Error(`unexpectedly refused: ${result.reason}`);
	}
	return result.text;
}

describe("applyHashline — the tag check", () => {
	it("applies when the tag matches and reports the new tag", () => {
		const text = "const a = 1;\n";

		const result = applyHashline({
			text,
			tag: hashlineTag(text),
			patch: "PUT 1.=1:\n+const a = 2;",
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toBe("const a = 2;\n");
		// The caller needs the new tag to stay anchored for a further edit
		// without re-reading the file.
		expect(result.tag).toBe(hashlineTag("const a = 2;\n"));
	});

	it("refuses a stale tag and reports the tag that is actually current", () => {
		// The whole point of the feature: the Agent read the file, then it
		// changed. Applying against bytes it never saw is how a file gets
		// silently corrupted.
		const stale = "const a = 1;\n";
		const current = "const a = 999;\n";

		const result = applyHashline({
			text: current,
			tag: hashlineTag(stale),
			patch: "PUT 1.=1:\n+const a = 2;",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		// The current tag is what makes the retry one round trip instead of a
		// re-read: the Agent can re-issue with this.
		expect(result.tag).toBe(hashlineTag(current));
		expect(result.reason).toContain("changed");
	});

	it("refuses a tag that isn't even valid hex", () => {
		const result = applyHashline({
			text: "a\n",
			tag: "ZZZZ",
			patch: "PUT 1.=1:\n+b",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("changed");
	});

	it("refuses a byte-identical edit rather than reporting a no-op as success", () => {
		// A no-op reported as success is a trap: the model believes the change
		// landed, and the file never moves.
		const result = applyHashline({
			text: "const a = 1;\n",
			tag: hashlineTag("const a = 1;\n"),
			patch: "PUT 1.=1:\n+const a = 1;",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("no change");
	});
});

describe("applyHashline — PUT forms", () => {
	it("replaces an inclusive line range", () => {
		expect(apply("a\nb\nc\nd\n", "PUT 2.=3:\n+B\n+C")).toBe("a\nB\nC\nd\n");
	});

	it("replaces a single line", () => {
		expect(apply("a\nb\nc\n", "PUT 2.=2:\n+Z")).toBe("a\nZ\nc\n");
	});

	it("inserts before a line", () => {
		expect(apply("a\nb\n", "PUT <2:\n+new")).toBe("a\nnew\nb\n");
	});

	it("inserts before line 1 (file head)", () => {
		expect(apply("a\nb\n", "PUT <1:\n+first")).toBe("first\na\nb\n");
	});

	it("inserts after a line", () => {
		expect(apply("a\nb\n", "PUT >1:\n+new")).toBe("a\nnew\nb\n");
	});

	it("appends at the tail", () => {
		expect(apply("a\nb\n", "PUT >$:\n+last")).toBe("a\nb\nlast\n");
	});

	it("writes a blank line for a bare + row", () => {
		expect(apply("a\nb\n", "PUT <2:\n+")).toBe("a\n\nb\n");
	});

	it("treats body rows as final content, not a diff pair", () => {
		// The `-` row is literal text: this is why the retry loop on bad diffs
		// disappears, since the model never has to reproduce old content.
		expect(apply("a\nb\n", "PUT 2.=2:\n+-literal")).toBe("a\n-literal\n");
	});

	it("preserves leading whitespace in body rows", () => {
		expect(apply("a\nb\n", "PUT 2.=2:\n+\tindented")).toBe("a\n\tindented\n");
	});
});

describe("applyHashline — anchor numbering", () => {
	it("resolves every hunk against the original lines, not the running result", () => {
		// The classic str_replace headache: after replacing line 1, line 3 is no
		// longer line 3. Hashline numbers are always original-snapshot numbers,
		// so both hunks below address the file as it was read.
		const text = "a\nb\nc\nd\n";

		expect(apply(text, "PUT 1.=1:\n+A\nPUT 3.=3:\n+C")).toBe("A\nb\nC\nd\n");
	});

	it("applies an insert and a replace in one patch without shifting each other", () => {
		const text = "a\nb\nc\n";

		expect(apply(text, "PUT >1:\n+x\nPUT 3.=3:\n+Z")).toBe("a\nx\nb\nZ\n");
	});

	it("inserts several rows in order", () => {
		expect(apply("a\nd\n", "PUT >1:\n+b\n+c")).toBe("a\nb\nc\nd\n");
	});
});

describe("applyHashline — refusals", () => {
	it("refuses an anchor past the end of the file", () => {
		const result = applyHashline({
			text: "a\nb\n",
			tag: hashlineTag("a\nb\n"),
			patch: "PUT 9.=9:\n+x",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toContain("line");
	});

	it("refuses a reversed range", () => {
		const result = applyHashline({
			text: "a\nb\nc\n",
			tag: hashlineTag("a\nb\nc\n"),
			patch: "PUT 3.=1:\n+x",
		});

		expect(result.ok).toBe(false);
	});

	it("refuses a patch with no recognizable operation", () => {
		const result = applyHashline({
			text: "a\n",
			tag: hashlineTag("a\n"),
			patch: "hello\n+world",
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason.toLowerCase()).toContain("no");
	});
});

describe("formatPatchResult", () => {
	it("shows the new tag and a numbered preview of the changed region", () => {
		const out = formatPatchResult("src/a.ts", "a\nB\nc\n", "PUT 2.=2:\n+B");

		expect(out).toContain("[src/a.ts#");
		// The model needs to see where the change landed to make its next move
		// without another read.
		expect(out).toContain("2:B");
	});
});
