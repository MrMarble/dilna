import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../db";
import { getRepoMemory, REPO_MEMORY_MAX_CHARS, setRepoMemory } from "./memory";

let dataDir: string;
let oldDataDir: string | undefined;

beforeAll(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-memory-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;
});

afterAll(() => {
	closeDb();
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
});

describe("repo memory", () => {
	it("returns empty string for a repo with no stored memory", async () => {
		expect(await getRepoMemory("no-such-repo")).toBe("");
	});

	it("writes and reads back memory content", async () => {
		const result = await setRepoMemory("repo-1", "- tests need FOO_ENV set");
		expect(result.ok).toBe(true);
		expect(await getRepoMemory("repo-1")).toBe("- tests need FOO_ENV set");
	});

	it("replaces (not merges) on a second write", async () => {
		await setRepoMemory("repo-2", "- fact one");
		await setRepoMemory("repo-2", "- fact two");
		expect(await getRepoMemory("repo-2")).toBe("- fact two");
	});

	it("clears memory when written with an empty string", async () => {
		await setRepoMemory("repo-3", "- some fact");
		await setRepoMemory("repo-3", "");
		expect(await getRepoMemory("repo-3")).toBe("");
	});

	it("rejects content over the size cap without writing it", async () => {
		await setRepoMemory("repo-4", "- kept");
		const tooLong = "x".repeat(REPO_MEMORY_MAX_CHARS + 1);

		const result = await setRepoMemory("repo-4", tooLong);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain(String(REPO_MEMORY_MAX_CHARS));
		expect(await getRepoMemory("repo-4")).toBe("- kept");
	});

	it("scopes memory independently per repo", async () => {
		await setRepoMemory("repo-a", "- a's fact");
		await setRepoMemory("repo-b", "- b's fact");
		expect(await getRepoMemory("repo-a")).toBe("- a's fact");
		expect(await getRepoMemory("repo-b")).toBe("- b's fact");
	});
});
