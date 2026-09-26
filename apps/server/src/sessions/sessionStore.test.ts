import { describe, expect, it } from "vitest";
import { fallbackSessionTitle } from "./sessionStore";

describe("fallbackSessionTitle", () => {
	it("uses the first non-empty line, collapsed", () => {
		expect(
			fallbackSessionTitle("Fix the login redirect bug\n\nand also the CSS"),
		).toBe("Fix the login redirect bug");
		expect(fallbackSessionTitle("\n \n\tAdd billing flow  ")).toBe(
			"Add billing flow",
		);
	});

	it("titles an attachment-only first turn after the filename", () => {
		expect(fallbackSessionTitle("[attached: screenshot.png]")).toBe(
			"screenshot.png",
		);
	});

	it("strips a leading markdown list marker", () => {
		expect(fallbackSessionTitle("- Fix the login redirect bug")).toBe(
			"Fix the login redirect bug",
		);
	});

	it("truncates long prompts at a word boundary with an ellipsis", () => {
		const prompt =
			"Refactor the whole authentication module so that sessions survive restarts";
		const title = fallbackSessionTitle(prompt);
		expect(title!.endsWith("…")).toBe(true);
		expect(title!.length).toBeLessThanOrEqual(49);
		expect(title).not.toContain("survives");
		// The cut is a clean prefix of the prompt — no mid-word invention.
		expect(prompt.startsWith(title!.slice(0, -1))).toBe(true);
	});

	it("hard-cuts a single unbroken overlong word", () => {
		const title = fallbackSessionTitle("a".repeat(80));
		expect(title!.length).toBe(49); // 48 chars + ellipsis
	});

	it("returns null when there is nothing to derive from", () => {
		expect(fallbackSessionTitle("")).toBeNull();
		expect(fallbackSessionTitle("  \n \t ")).toBeNull();
	});
});
