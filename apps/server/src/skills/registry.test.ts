import { describe, expect, it } from "vitest";
import { parseSkillSource } from "./registry";

describe("parseSkillSource", () => {
	it("parses a skills.sh skill URL into repo + skill", () => {
		expect(
			parseSkillSource("https://www.skills.sh/mattpocock/skills/tdd"),
		).toEqual({ repo: "mattpocock/skills", skill: "tdd" });
	});

	it("parses a skills.sh URL without the www prefix", () => {
		expect(parseSkillSource("https://skills.sh/mattpocock/skills/tdd")).toEqual(
			{
				repo: "mattpocock/skills",
				skill: "tdd",
			},
		);
	});

	it("parses a bare GitHub repo URL with no skill folder", () => {
		expect(parseSkillSource("https://github.com/mattpocock/skills")).toEqual({
			repo: "mattpocock/skills",
		});
	});

	it("strips a trailing .git from a GitHub repo URL", () => {
		expect(parseSkillSource("https://github.com/owner/repo.git")).toEqual({
			repo: "owner/repo",
		});
	});

	it("takes the last path segment of a GitHub tree URL as the skill", () => {
		expect(
			parseSkillSource(
				"https://github.com/mattpocock/skills/tree/main/skills/engineering/tdd",
			),
		).toEqual({ repo: "mattpocock/skills", skill: "tdd" });
	});

	it("parses owner/repo/skill shorthand", () => {
		expect(parseSkillSource("mattpocock/skills/tdd")).toEqual({
			repo: "mattpocock/skills",
			skill: "tdd",
		});
	});

	it("ignores trailing slashes", () => {
		expect(parseSkillSource("https://www.skills.sh/owner/repo/skill/")).toEqual(
			{
				repo: "owner/repo",
				skill: "skill",
			},
		);
	});

	it("rejects hosts other than skills.sh and github.com", () => {
		expect(
			parseSkillSource("https://evil.example.com/owner/repo/skill"),
		).toBeNull();
	});

	it("rejects input with no repo part", () => {
		expect(parseSkillSource("owner")).toBeNull();
		expect(parseSkillSource("")).toBeNull();
		expect(parseSkillSource("   ")).toBeNull();
	});
});
