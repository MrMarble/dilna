import { describe, expect, it } from "vitest";
import { parseCommitsLimit } from "./sessions";

describe("parseCommitsLimit", () => {
	it("passes through a valid limit", () => {
		expect(parseCommitsLimit("10")).toBe(10);
		expect(parseCommitsLimit("1")).toBe(1);
		expect(parseCommitsLimit("50")).toBe(50);
	});

	it("falls back to undefined for missing, non-numeric, or out-of-range input", () => {
		expect(parseCommitsLimit(undefined)).toBeUndefined();
		expect(parseCommitsLimit("")).toBeUndefined();
		expect(parseCommitsLimit("abc")).toBeUndefined();
		expect(parseCommitsLimit("0")).toBeUndefined();
		expect(parseCommitsLimit("-5")).toBeUndefined();
		expect(parseCommitsLimit("51")).toBeUndefined();
		expect(parseCommitsLimit("3.5")).toBeUndefined();
	});
});
