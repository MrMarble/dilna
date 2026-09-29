import { TOOL_NAMES } from "@dilna/shared";
import { describe, expect, it } from "vitest";
import { charsPerTokenFor } from "./providerConfig";
import {
	builtInToolSchemaChars,
	TOOL_BURN_CLASSIFICATION,
	toolSchemaTokens,
} from "./toolSchemaWeight";

describe("builtInToolSchemaChars (issue #296)", () => {
	it("measures exactly the built-in universe, every weight positive and substantial", () => {
		const chars = builtInToolSchemaChars();
		// Total over TOOL_NAMES — a tool registered by startPi but missing from
		// the shared list (or vice versa) must fail here, not silently zero a
		// finding's waste estimate.
		expect(Object.keys(chars).sort()).toEqual([...TOOL_NAMES].sort());
		for (const name of TOOL_NAMES) {
			// A declaration is name + description + JSON schema; dilna's
			// descriptions are paragraphs, so anything near-zero means the
			// measurement broke, not that a tool got cheap.
			expect(chars[name]).toBeGreaterThan(100);
		}
	});

	it("is memoized — repeated calls return the same measurements", () => {
		expect(builtInToolSchemaChars()).toBe(builtInToolSchemaChars());
	});

	it("estimates tokens with the provider's calibrated charsPerToken, ceiled", () => {
		const chars = builtInToolSchemaChars();
		for (const provider of ["anthropic", "some-custom-provider"]) {
			for (const name of TOOL_NAMES) {
				expect(toolSchemaTokens(name, provider)).toBe(
					Math.ceil(chars[name] / charsPerTokenFor(provider)),
				);
			}
		}
		// Denser packing (smaller chars/token) means more estimated tokens —
		// the finding's waste must not under-count on the dangerous side.
		expect(toolSchemaTokens("bash", "anthropic")).toBeGreaterThanOrEqual(
			toolSchemaTokens("bash", "some-custom-provider"),
		);
	});
});

describe("TOOL_BURN_CLASSIFICATION (issue #296)", () => {
	it("is total over the built-in universe (compile-enforced; asserted for runtime safety)", () => {
		for (const name of TOOL_NAMES) {
			expect(["structural", "situational"]).toContain(
				TOOL_BURN_CLASSIFICATION[name],
			);
		}
	});

	it("classifies the coding loop as structural and dilna's extras as situational", () => {
		// pi's built-in coding loop plus the two tools dilna's own features
		// lean on (task delegation ADR-0034, skill progressive disclosure
		// issue #60): an Agent without these isn't dilna.
		for (const structural of [
			"read",
			"write",
			"edit",
			"grep",
			"find",
			"ls",
			"bash",
			"task",
			"read_skill",
		] as const) {
			expect(TOOL_BURN_CLASSIFICATION[structural]).toBe("structural");
		}
		// Additions a use case can plausibly never touch.
		for (const situational of [
			"read_repo_memory",
			"update_repo_memory",
			"fetch",
			"dilna_publish_artefact",
			"dilna_send_image",
		] as const) {
			expect(TOOL_BURN_CLASSIFICATION[situational]).toBe("situational");
		}
	});

	it("keeps codegraph out of the finding universe (conditionally registered)", () => {
		// codegraph is only registered when the Worktree has a .codegraph/
		// index, which usage_events doesn't record — finding T's universe is
		// exactly TOOL_NAMES, and this pins that exclusion in case TOOL_NAMES
		// ever grows it.
		expect(TOOL_NAMES).not.toContain("codegraph");
	});
});
