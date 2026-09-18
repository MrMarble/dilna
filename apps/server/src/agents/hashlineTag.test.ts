import { describe, expect, it } from "vitest";
import { hashlineTag } from "./hashlineTag";

describe("hashlineTag", () => {
	// Ground truth: these three vectors are oh-my-pi's own `store.rs` test
	// expectations for `file_hash` (crates/pi-edit/src/store.rs). They are the
	// compatibility contract — a port that doesn't reproduce them byte-for-byte
	// would mint tags that mean something different from omp's, which is the
	// one thing this shared vocabulary has to get right. Independently sourced,
	// not recomputed from our own implementation.
	it.each([
		["a \n b\t\r\nc", "80BA"],
		["hello\n", "5BF9"],
		["", "5D05"],
	])("matches oh-my-pi's vector for %j", (input, expected) => {
		expect(hashlineTag(input)).toBe(expected);
	});

	it("ignores trailing whitespace on each line", () => {
		// The normalization trims trailing spaces/tabs per line, so a file that
		// only differs by trailing whitespace hashes the same — an edit anchored
		// before a stray trailing space shouldn't be refused for it.
		expect(hashlineTag("const a = 1;   \nconst b = 2;\n")).toBe(
			hashlineTag("const a = 1;\nconst b = 2;\n"),
		);
	});

	it("ignores a BOM and CRLF line endings", () => {
		expect(hashlineTag("\uFEFFa\r\nb\r\n")).toBe(hashlineTag("a\nb\n"));
	});

	it("changes when line content changes", () => {
		expect(hashlineTag("const a = 1;\n")).not.toBe(
			hashlineTag("const a = 2;\n"),
		);
	});

	it("is always four uppercase hex digits", () => {
		for (const text of ["", "x", "\n\n\n", "a".repeat(10_000)]) {
			expect(hashlineTag(text)).toMatch(/^[0-9A-F]{4}$/);
		}
	});
});
