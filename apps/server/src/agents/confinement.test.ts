import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BeforeToolCallContext } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConfinementHook, isContained } from "./confinement";

/**
 * Real filesystem + real symlinks, not mocked `fs` — per
 * docs/research/pi-tool-confinement.md, `realpathSync` symlink-resolution
 * behavior is the actual bug surface this wrapper exists to close, so a
 * mocked `fs` would test nothing meaningful here.
 */
describe("confinement", () => {
	let worktree: string;
	let outside: string;

	beforeEach(() => {
		worktree = mkdtempSync(path.join(tmpdir(), "dilna-confinement-worktree-"));
		outside = mkdtempSync(path.join(tmpdir(), "dilna-confinement-outside-"));
		writeFileSync(path.join(worktree, "inside.txt"), "inside\n");
		writeFileSync(path.join(outside, "secret.txt"), "secret\n");
		mkdirSync(path.join(worktree, "nested"));
	});

	afterEach(() => {
		rmSync(worktree, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	});

	describe("isContained", () => {
		it("allows a path inside the worktree", () => {
			expect(isContained(path.join(worktree, "inside.txt"), worktree)).toBe(
				true,
			);
		});

		it("allows the worktree root itself", () => {
			expect(isContained(worktree, worktree)).toBe(true);
		});

		it("blocks a path outside the worktree", () => {
			expect(isContained(path.join(outside, "secret.txt"), worktree)).toBe(
				false,
			);
		});

		it("blocks a symlink planted inside the worktree pointing outside it", () => {
			const link = path.join(worktree, "escape");
			symlinkSync(outside, link);
			expect(isContained(path.join(link, "secret.txt"), worktree)).toBe(false);
		});

		it("allows a not-yet-existing path inside the worktree (e.g. a fresh write target)", () => {
			expect(isContained(path.join(worktree, "new-file.txt"), worktree)).toBe(
				true,
			);
		});

		it("allows a not-yet-existing path under not-yet-existing directories inside the worktree", () => {
			expect(
				isContained(path.join(worktree, "a", "b", "new-file.txt"), worktree),
			).toBe(true);
		});

		// Regression: a naive "realpathSync fails -> trust the lexical path"
		// fallback can't tell this apart from a genuinely new in-worktree file,
		// since realpathSync ENOENTs in both cases — the leaf doesn't exist
		// under `escape` either way. The fix has to resolve the *symlink itself*
		// (which does exist) rather than giving up at the first ENOENT.
		it("blocks a not-yet-existing leaf underneath a symlink that points outside the worktree", () => {
			const link = path.join(worktree, "escape");
			symlinkSync(outside, link);
			expect(
				isContained(path.join(link, "not-yet-created.txt"), worktree),
			).toBe(false);
		});

		it("blocks a not-yet-existing leaf under not-yet-existing directories underneath an escaping symlink", () => {
			const link = path.join(worktree, "escape");
			symlinkSync(outside, link);
			expect(
				isContained(path.join(link, "new-dir", "new-file.txt"), worktree),
			).toBe(false);
		});
	});

	function ctx(
		toolName: string,
		args: Record<string, unknown>,
	): BeforeToolCallContext {
		return {
			assistantMessage: {
				role: "assistant",
				content: [],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			toolCall: {
				type: "toolCall",
				id: "call-1",
				name: toolName,
				arguments: args,
			},
			args,
			context: { systemPrompt: "", messages: [] },
		};
	}

	describe("createConfinementHook", () => {
		const PATH_TOOLS = ["read", "write", "edit", "grep", "find", "ls"];

		it.each(
			PATH_TOOLS,
		)("allows a relative in-worktree path for %s", async (tool) => {
			const hook = createConfinementHook(worktree);
			const result = await hook(ctx(tool, { path: "nested" }));
			expect(result).toBeUndefined();
		});

		it.each(
			PATH_TOOLS,
		)("blocks an absolute path outside the worktree for %s", async (tool) => {
			const hook = createConfinementHook(worktree);
			const result = await hook(
				ctx(tool, { path: path.join(outside, "secret.txt") }),
			);
			expect(result?.block).toBe(true);
			expect(result?.reason).toContain("outside the worktree");
		});

		it.each(PATH_TOOLS)("blocks a ../ traversal for %s", async (tool) => {
			const hook = createConfinementHook(worktree);
			const result = await hook(ctx(tool, { path: "../escape.txt" }));
			expect(result?.block).toBe(true);
		});

		it.each(
			PATH_TOOLS,
		)("blocks a symlink planted inside the worktree pointing outside it for %s", async (tool) => {
			const link = path.join(worktree, `escape-${tool}`);
			symlinkSync(outside, link);
			const hook = createConfinementHook(worktree);
			const result = await hook(
				ctx(tool, { path: `escape-${tool}/secret.txt` }),
			);
			expect(result?.block).toBe(true);
		});

		// The attachment directory (issue #53, ADR-0031): readable so the Agent
		// can act on an upload, never writable — copying a file *into* the
		// worktree is the supported move, editing the user's original is not.
		describe("with a read-only root (the session's attachments)", () => {
			it.each([
				"read",
				"grep",
				"find",
				"ls",
			])("allows %s inside the read-only root", async (tool) => {
				const hook = createConfinementHook(worktree, [outside]);
				const result = await hook(
					ctx(tool, { path: path.join(outside, "secret.txt") }),
				);
				expect(result).toBeUndefined();
			});

			it.each([
				"write",
				"edit",
			])("still blocks %s inside the read-only root", async (tool) => {
				const hook = createConfinementHook(worktree, [outside]);
				const result = await hook(
					ctx(tool, { path: path.join(outside, "secret.txt") }),
				);
				expect(result?.block).toBe(true);
			});

			it("blocks a read outside both the worktree and the read-only root", async () => {
				const elsewhere = mkdtempSync(
					path.join(tmpdir(), "dilna-confinement-elsewhere-"),
				);
				try {
					writeFileSync(path.join(elsewhere, "other.txt"), "other\n");
					const hook = createConfinementHook(worktree, [outside]);
					const result = await hook(
						ctx("read", { path: path.join(elsewhere, "other.txt") }),
					);
					expect(result?.block).toBe(true);
				} finally {
					rmSync(elsewhere, { recursive: true, force: true });
				}
			});

			it("leaves the worktree fully writable", async () => {
				const hook = createConfinementHook(worktree, [outside]);
				const result = await hook(
					ctx("write", { path: "nested/new-file.txt" }),
				);
				expect(result).toBeUndefined();
			});
		});

		it("passes a non-path tool (bash) through untouched", async () => {
			const hook = createConfinementHook(worktree);
			const result = await hook(ctx("bash", { command: "rm -rf /" }));
			expect(result).toBeUndefined();
		});

		it("defaults a missing path argument to the worktree root (grep/find/ls's own default)", async () => {
			const hook = createConfinementHook(worktree);
			const result = await hook(ctx("ls", {}));
			expect(result).toBeUndefined();
		});

		it.each(
			PATH_TOOLS,
		)("blocks a not-yet-existing leaf underneath an escaping symlink for %s", async (tool) => {
			const link = path.join(worktree, `escape-new-${tool}`);
			symlinkSync(outside, link);
			const hook = createConfinementHook(worktree);
			const result = await hook(
				ctx(tool, { path: `escape-new-${tool}/not-yet-created.txt` }),
			);
			expect(result?.block).toBe(true);
		});

		// pi-coding-agent's own path resolution expands a leading `~`/`~/...`
		// to the real host home directory by default — the hook has to match
		// that or a tilde path lexically "inside" the worktree (as a literal
		// directory named "~") slips through while the real tool call escapes.
		it("blocks a bare ~ path (expands to the real home directory, outside the worktree)", async () => {
			const hook = createConfinementHook(worktree);
			const result = await hook(ctx("read", { path: "~" }));
			expect(result?.block).toBe(true);
		});

		it("blocks a ~/... path (expands to the real home directory, outside the worktree)", async () => {
			const hook = createConfinementHook(worktree);
			const result = await hook(ctx("read", { path: "~/.ssh/id_rsa" }));
			expect(result?.block).toBe(true);
		});

		it("does not mistake a literal '~something' for a tilde-expansion path", async () => {
			// Only exactly "~" or "~/..." expand — a literal in-worktree
			// directory that happens to start with ~ is not home-relative.
			mkdirSync(path.join(worktree, "~backup"));
			const hook = createConfinementHook(worktree);
			const result = await hook(ctx("read", { path: "~backup" }));
			expect(result).toBeUndefined();
		});
	});
});
