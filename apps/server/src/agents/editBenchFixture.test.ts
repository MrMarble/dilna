import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createEditFixture } from "./editBenchFixture";

describe("createEditFixture", () => {
	const created: string[] = [];

	afterEach(() => {
		for (const dir of created.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("creates a git repo whose committed file matches the fixture's initial text", () => {
		const fixture = createEditFixture();
		created.push(fixture.repoDir);

		// The file on disk is the initial text, and it is committed — a
		// Session's worktree is cloned from HEAD, so an uncommitted fixture
		// would arrive empty.
		expect(readFileSync(fixture.filePath, "utf8")).toBe(fixture.initialText);

		const status = execFileSync("git", ["status", "--porcelain"], {
			cwd: fixture.repoDir,
			encoding: "utf8",
		});
		expect(status.trim()).toBe("");

		// A real commit exists, so `git worktree add` from it will work.
		const subject = execFileSync("git", ["log", "-1", "--pretty=%s"], {
			cwd: fixture.repoDir,
			encoding: "utf8",
		});
		expect(subject.trim()).toBe("fixture: initial state");
	});

	it("gives each fixture its own directory", () => {
		const a = createEditFixture();
		const b = createEditFixture();
		created.push(a.repoDir, b.repoDir);

		expect(a.repoDir).not.toBe(b.repoDir);
		// Independent repos: writing to one doesn't touch the other.
		writeFileSync(a.filePath, "changed\n");
		expect(readFileSync(b.filePath, "utf8")).toBe(b.initialText);
	});

	it("hands back a task and the expected post-edit text, which differ", () => {
		const fixture = createEditFixture();
		created.push(fixture.repoDir);

		// The whole harness rests on this: a task whose success is decidable by
		// comparing the file to `expectedText`, and which actually requires a
		// change. A task whose expected text equals the initial text would make
		// every model pass for free.
		expect(fixture.expectedText).not.toBe(fixture.initialText);
		expect(fixture.task.length).toBeGreaterThan(0);
	});

	it("has an initial text long enough to make line addressing meaningful", () => {
		const fixture = createEditFixture();
		created.push(fixture.repoDir);

		// A one-line fixture can't distinguish line-number addressing from
		// text quoting. The point of the A/B is edits in a file big enough
		// that quoting the old text is expensive.
		expect(fixture.initialText.split("\n").length).toBeGreaterThan(50);
	});
});
