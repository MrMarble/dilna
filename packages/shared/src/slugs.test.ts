import { describe, expect, it } from "vitest";
import { isReservedSlug, RESERVED_SLUGS } from "./slugs";

describe("RESERVED_SLUGS", () => {
	it("holds the top-level path segments the web's router claims", () => {
		expect([...RESERVED_SLUGS].sort()).toEqual(
			["compare", "metrics", "orchestrator", "settings", "skills"].sort(),
		);
	});
});

describe("isReservedSlug", () => {
	it("flags a slug a standalone view's path would shadow", () => {
		for (const slug of RESERVED_SLUGS) {
			expect(isReservedSlug(slug)).toBe(true);
		}
	});

	it("leaves ordinary slugs alone", () => {
		expect(isReservedSlug("dilna")).toBe(false);
		expect(isReservedSlug("my-metrics")).toBe(false);
	});
});
