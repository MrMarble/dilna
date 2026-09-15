import type { RepoSkill } from "@dilna/shared";
import { describe, expect, it } from "vitest";
import {
	applySlashCommand,
	matchSkills,
	slashQuery,
} from "@/lib/slash-commands";

function skill(name: string, description = ""): RepoSkill {
	return {
		id: `owner/repo/${name}`,
		source: "owner/repo",
		slug: name,
		name,
		description,
		sourceUrl: `https://github.com/owner/repo/${name}`,
		installedAt: 1,
		enabled: true,
	};
}

describe("slashQuery", () => {
	it("opens on a bare slash with an empty query", () => {
		expect(slashQuery("/")).toBe("");
	});

	it("returns the typed command token as the filter", () => {
		expect(slashQuery("/code-rev")).toBe("code-rev");
	});

	it("stays closed when the slash is not the first character", () => {
		// `src/lib` and `and/or` are paths and prose, not commands.
		expect(slashQuery("look in src/lib")).toBeNull();
		expect(slashQuery(" /verify")).toBeNull();
	});

	it("closes on the space after the command", () => {
		expect(slashQuery("/verify ")).toBeNull();
		expect(slashQuery("/verify the login flow")).toBeNull();
	});

	it("closes once the draft spans lines", () => {
		expect(slashQuery("/verify\nmore")).toBeNull();
	});

	it("stays closed for an empty composer", () => {
		expect(slashQuery("")).toBeNull();
	});
});

describe("matchSkills", () => {
	const skills = [skill("code-review"), skill("verify"), skill("grill-me")];

	it("offers every Skill for the empty query", () => {
		expect(matchSkills(skills, "").map((c) => c.name)).toEqual([
			"code-review",
			"verify",
			"grill-me",
		]);
	});

	it("matches case-insensitively", () => {
		expect(matchSkills(skills, "VER").map((c) => c.name)).toEqual(["verify"]);
	});

	it("ranks prefix matches above substring ones", () => {
		const skills2 = [skill("code-review"), skill("review-notes")];
		expect(matchSkills(skills2, "review").map((c) => c.name)).toEqual([
			"review-notes",
			"code-review",
		]);
	});

	it("returns nothing when the query matches no Skill", () => {
		expect(matchSkills(skills, "zzz")).toEqual([]);
	});

	it("carries the description through for the menu row", () => {
		const matched = matchSkills([skill("verify", "Check the work")], "ver");
		expect(matched[0]?.description).toBe("Check the work");
	});
});

describe("applySlashCommand", () => {
	it("inserts the command with a trailing space, which also closes the menu", () => {
		const text = applySlashCommand("code-review");
		expect(text).toBe("/code-review ");
		expect(slashQuery(text)).toBeNull();
	});
});
