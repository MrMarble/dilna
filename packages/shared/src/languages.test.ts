import { describe, expect, it } from "vitest";
import {
	DILNA_LANGUAGES,
	EXTENSION_LANGUAGES,
	languageForExtension,
} from "./languages";

describe("DILNA_LANGUAGES", () => {
	it("is exactly the set of names the extension map can emit", () => {
		// The union is derived from the map's values, so these can't drift —
		// but pin the shape so a new name has to be a deliberate addition.
		expect(new Set(Object.values(EXTENSION_LANGUAGES))).toEqual(
			new Set(DILNA_LANGUAGES),
		);
	});

	it("has no duplicate names", () => {
		expect(new Set(DILNA_LANGUAGES).size).toBe(DILNA_LANGUAGES.length);
	});

	it("includes the names the web's colour map once omitted", () => {
		// The web map carried a comment asserting it matched the server's; it
		// didn't, missing ten names that then rendered grey and iconless.
		for (const name of [
			"Erlang",
			"Clojure",
			"SQL",
			"R",
			"Julia",
			"Nim",
			"OCaml",
			"F#",
			"HCL",
			"Protocol Buffers",
		]) {
			expect(DILNA_LANGUAGES).toContain(name);
		}
	});
});

describe("languageForExtension", () => {
	it("maps a known extension to its language", () => {
		expect(languageForExtension("ts")).toBe("TypeScript");
		expect(languageForExtension("rs")).toBe("Rust");
	});

	it("is case-insensitive", () => {
		expect(languageForExtension("TS")).toBe("TypeScript");
	});

	it("returns undefined for an unknown extension", () => {
		expect(languageForExtension("docx")).toBeUndefined();
		expect(languageForExtension("")).toBeUndefined();
	});
});
