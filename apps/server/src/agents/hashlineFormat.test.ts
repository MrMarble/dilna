import { describe, expect, it } from "vitest";
import { formatTaggedLines } from "./hashlineFormat";
import { hashlineTag } from "./hashlineTag";

describe("formatTaggedLines", () => {
	it("emits a tagged header followed by 1-indexed numbered lines", () => {
		const text = "const a = 1;\nconst b = 2;\n";

		expect(formatTaggedLines("src/config.ts", text)).toBe(
			`[src/config.ts#${hashlineTag(text)}]\n1:const a = 1;\n2:const b = 2;`,
		);
	});

	it("numbers the lines the caller asked for, not from 1", () => {
		// A read with an offset shows a slice; the numbers must be the file's
		// real line numbers, because those are what an edit anchors to. The
		// caller slices, this numbers.
		const full = "a\nb\nc\nd\n";
		const slice = "c\nd\n";

		expect(formatTaggedLines("f.ts", full, { startLine: 3 })).toBe(
			`[f.ts#${hashlineTag(full)}]\n3:a\n4:b\n5:c\n6:d`,
		);
		// And the slice of the same file, numbered from where it starts.
		expect(formatTaggedLines("f.ts", slice, { startLine: 3 })).toBe(
			`[f.ts#${hashlineTag(slice)}]\n3:c\n4:d`,
		);
	});

	it("tags the text it was given, which is why the caller must pass the whole file", () => {
		// The tag identifies the file an edit will apply to, so a partial read
		// must still be tagged from full content. This documents the trap: a
		// slice tags as a slice, and an edit anchored in it could never match.
		const full = "a\nb\nc\nd\n";
		const slice = "c\nd\n";

		const out = formatTaggedLines("f.ts", full, { startLine: 3 });

		expect(out).toContain(`#${hashlineTag(full)}`);
		expect(out).not.toContain(`#${hashlineTag(slice)}`);
	});

	it("does not leave a trailing blank line for text ending in a newline", () => {
		expect(formatTaggedLines("f.ts", "a\n")).toBe(
			`[f.ts#${hashlineTag("a\n")}]\n1:a`,
		);
	});

	it("handles empty content", () => {
		expect(formatTaggedLines("f.ts", "")).toBe(`[f.ts#${hashlineTag("")}]`);
	});
});
