import { describe, expect, it } from "vitest";
import { CODEGRAPH_MAX_OUTPUT_CHARS, capOutput } from "./codegraphTool";

/**
 * `createCodegraphTool`'s `execute()` shells out to a binary this repo does
 * not ship, so what is worth pinning here is the pure part: the output cap.
 * It is load-bearing — explore's own budget is tuned for a read (upstream
 * measures ~80% more residual context than a grep/read loop), so dilna's
 * cap is the thing standing between one call and a filled context window —
 * and it is invisible when it works.
 */
describe("capOutput", () => {
	it("returns output shorter than the cap untouched, byte for byte", () => {
		const text = "**Exploration: x**\n\n```ts\n1\tconst a = 1;\n```";
		expect(capOutput(text)).toBe(text);
	});

	it("returns output exactly at the cap untouched", () => {
		const text = "x".repeat(CODEGRAPH_MAX_OUTPUT_CHARS);
		expect(capOutput(text)).toBe(text);
	});

	it("cuts past the cap and says so, keeping the head", () => {
		// Twice the cap, so the note the cap appends is still net-negative.
		const text = `HEAD${"x".repeat(CODEGRAPH_MAX_OUTPUT_CHARS * 2)}TAIL`;
		const capped = capOutput(text);
		expect(capped.length).toBeLessThan(text.length);
		expect(capped.startsWith("HEAD")).toBe(true);
		expect(capped).not.toContain("TAIL");
		// The marker is the whole point: a silently truncated answer reads
		// as a complete one, and the model concludes the rest doesn't exist.
		expect(capped).toContain("truncated");
		expect(capped).toContain(String(CODEGRAPH_MAX_OUTPUT_CHARS));
	});

	it("honours an explicit cap", () => {
		expect(capOutput("abcdefghij", 4)).toContain("abcd");
		expect(capOutput("abcdefghij", 4)).not.toContain("efghij");
	});
});
