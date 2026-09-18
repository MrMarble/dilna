import { DILNA_LANGUAGES } from "@dilna/shared";
import { describe, expect, it } from "vitest";
import { languageColor } from "@/lib/languages";

const FALLBACK_COLOR = "#8b949e";

/**
 * The language colour map is the web's half of the language vocabulary: the
 * server derives a language *name* from a file extension and this decides how
 * it renders. It used to carry a comment asserting it matched the server's
 * map; it didn't, and ten names the server emits fell through to the neutral
 * grey — a Clojure or Erlang repo was indistinguishable from an unrecognised
 * one.
 *
 * Typed `Record<DilnaLanguage, …>`, the compiler now catches a *missing* name.
 * This catches the other direction at runtime: a name that is present but
 * still resolves to the fallback.
 */
describe("languageColor", () => {
	it("has a distinct colour for every language the server can emit", () => {
		for (const name of DILNA_LANGUAGES) {
			expect(
				languageColor(name),
				`${name} has no colour — it renders grey and iconless`,
			).not.toBe(FALLBACK_COLOR);
		}
	});

	it("falls back for an unknown language", () => {
		expect(languageColor("Brainfuck")).toBe(FALLBACK_COLOR);
		expect(languageColor("")).toBe(FALLBACK_COLOR);
	});
});
