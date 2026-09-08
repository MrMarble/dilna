import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	ensureWritablePathsExist,
	findWorkspaceRoot,
	listSiblingWorktreeDirs,
	resolveGitCommonDir,
	resolveSandboxGrant,
	toolchainEnv,
} from "./worktreeSandbox";

/**
 * Real filesystem against a `mkdtemp` tree, no `Agent`, no bwrap, no LLM —
 * which is the entire point of issue #177's extraction: before it, every one
 * of these assertions required constructing a real `Agent`, so the sandbox
 * grant had zero test coverage and its regressions (a Session that can read
 * a sibling Session's Worktree; a `pnpm install` that copies 700 packages
 * instead of hardlinking) were silent and caught only by dogfooding.
 *
 * `fs` is deliberately not mocked: the grant's job is to describe real
 * directories (a git worktree's `.git` pointer chain, the sibling
 * enumeration, the workspace-root walk), so a mocked `fs` would assert only
 * that the code calls the functions we already know it calls.
 *
 * These tests cannot prove bwrap still behaves — that needs an isolated
 * instance and a real `pnpm install` checked for link count (see the issue's
 * own caveat). What they do lock down is the *data* handed to bwrap, which is
 * where every past regression here actually originated.
 */
describe("worktreeSandbox", () => {
	let root: string;
	let dataDir: string;
	let worktreesDir: string;
	let worktree: string;

	/** Every toolchain var `toolchainEnv` defers to when already set. The
	 * process running these tests may itself be inside a dilna Session (which
	 * exports exactly these), so they're cleared per-test to assert the
	 * *derived defaults*; the override path gets its own test below. */
	const OVERRIDABLE_VARS = [
		"DILNA_DATA_DIR",
		"PNPM_CONFIG_STORE_DIR",
		"PNPM_CONFIG_PACKAGE_IMPORT_METHOD",
		"MISE_DATA_DIR",
		"MISE_CONFIG_DIR",
		"MISE_CACHE_DIR",
		"MISE_STATE_DIR",
		"XDG_CACHE_HOME",
		"XDG_DATA_HOME",
		"XDG_CONFIG_HOME",
		"GH_CONFIG_DIR",
		// TMPDIR is deliberately NOT cleared: `mkdtempSync(tmpdir())` below
		// builds the whole fixture tree under it, and os.tmpdir() reads it.
	] as const;
	let savedEnv: Record<string, string | undefined>;

	beforeEach(() => {
		savedEnv = {};
		for (const key of OVERRIDABLE_VARS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		root = mkdtempSync(path.join(tmpdir(), "dilna-sandbox-"));
		dataDir = path.join(root, "data");
		worktreesDir = path.join(dataDir, "worktrees");
		worktree = path.join(worktreesDir, "acme-repo", "session-own");
		mkdirSync(worktree, { recursive: true });
		// getDataDir() reads this fresh on every call — the extraction
		// deliberately derives every path per call rather than memoizing at
		// import time, which is what lets a test relocate the whole tree.
		process.env.DILNA_DATA_DIR = dataDir;
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	});

	/** A worktree whose `.git` file points at metadata whose `commondir` in
	 * turn points at the shared git dir — the real layout `git worktree add`
	 * produces, which `resolveGitCommonDir` has to walk two hops of. */
	function writeWorktreeGitPointer(
		worktreePath: string,
		sharedGitDir: string,
	): void {
		const worktreeGitDir = path.join(
			sharedGitDir,
			"worktrees",
			path.basename(worktreePath),
		);
		mkdirSync(worktreeGitDir, { recursive: true });
		// `commondir` is written relative, exactly as git writes it.
		writeFileSync(path.join(worktreeGitDir, "commondir"), "../..\n");
		writeFileSync(
			path.join(worktreePath, ".git"),
			`gitdir: ${worktreeGitDir}\n`,
		);
	}

	describe("resolveGitCommonDir", () => {
		it("resolves the shared git dir through the two-hop pointer chain", () => {
			const shared = path.join(root, "repos", "acme.git");
			mkdirSync(shared, { recursive: true });
			writeWorktreeGitPointer(worktree, shared);

			expect(resolveGitCommonDir(worktree)).toBe(shared);
		});

		it("degrades to null rather than throwing when there is no .git at all", () => {
			expect(resolveGitCommonDir(worktree)).toBeNull();
		});

		it("degrades to null when .git is a real directory (a plain checkout, not a worktree)", () => {
			mkdirSync(path.join(worktree, ".git"));

			expect(resolveGitCommonDir(worktree)).toBeNull();
		});

		it("degrades to null when the gitdir target has no commondir", () => {
			const worktreeGitDir = path.join(root, "orphan-gitdir");
			mkdirSync(worktreeGitDir, { recursive: true });
			writeFileSync(path.join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);

			expect(resolveGitCommonDir(worktree)).toBeNull();
		});
	});

	describe("listSiblingWorktreeDirs", () => {
		it("enumerates every other session's worktree across repos, excluding its own", () => {
			const sibling1 = path.join(worktreesDir, "acme-repo", "session-other");
			const sibling2 = path.join(worktreesDir, "other-repo", "session-x");
			mkdirSync(sibling1, { recursive: true });
			mkdirSync(sibling2, { recursive: true });

			const siblings = listSiblingWorktreeDirs(worktreesDir, worktree);

			expect(siblings.sort()).toEqual([sibling1, sibling2].sort());
			expect(siblings).not.toContain(worktree);
		});

		it("never mistakes the shared pnpm store for a repo slug", () => {
			// The store lives directly under the worktrees dir, alongside repo
			// slugs, and has package dirs nested under it that look structurally
			// like session dirs. Masking it would defeat the whole point of
			// colocating it there (pnpm could no longer read its own store).
			const storePackage = path.join(worktreesDir, ".pnpm-store", "v10");
			mkdirSync(storePackage, { recursive: true });

			const siblings = listSiblingWorktreeDirs(worktreesDir, worktree);

			expect(siblings).toEqual([]);
		});

		it("ignores loose files at both the repo and session level", () => {
			writeFileSync(path.join(worktreesDir, "stray.txt"), "x");
			writeFileSync(path.join(worktreesDir, "acme-repo", "notes.md"), "x");

			expect(listSiblingWorktreeDirs(worktreesDir, worktree)).toEqual([]);
		});

		it("returns empty rather than throwing when the worktrees dir does not exist", () => {
			expect(
				listSiblingWorktreeDirs(path.join(root, "nope"), worktree),
			).toEqual([]);
		});
	});

	describe("findWorkspaceRoot", () => {
		it("walks up to the nearest pnpm-workspace.yaml", () => {
			const checkout = path.join(root, "checkout");
			const nested = path.join(checkout, "apps", "server", "src");
			mkdirSync(nested, { recursive: true });
			writeFileSync(path.join(checkout, "pnpm-workspace.yaml"), "packages:\n");

			expect(findWorkspaceRoot(nested)).toBe(checkout);
		});

		it("falls back to the start dir when no marker exists anywhere above", () => {
			const orphan = path.join(root, "orphan");
			mkdirSync(orphan, { recursive: true });

			expect(findWorkspaceRoot(orphan)).toBe(orphan);
		});
	});

	describe("resolveSandboxGrant", () => {
		it("binds the worktrees dir as the writable ancestor, not the worktree itself", () => {
			// The load-bearing invariant behind pnpm hardlinking: the worktree
			// and the shared store must be reached as plain children of one
			// bound ancestor. Listing either on its own re-binds it as a separate
			// bwrap mount and link(2) starts returning EXDEV, silently degrading
			// every `pnpm install` to a full byte-for-byte copy.
			const grant = resolveSandboxGrant(worktree);

			expect(grant.writablePaths).toContain(worktreesDir);
			expect(grant.writablePaths).not.toContain(worktree);
		});

		it("never emits the pnpm store as its own bind path", () => {
			const grant = resolveSandboxGrant(worktree);
			const store = path.join(worktreesDir, ".pnpm-store");

			expect(grant.writablePaths).not.toContain(store);
			expect(grant.denyReadPaths).not.toContain(store);
			// ...while still pointing pnpm *at* it, which is the pairing that
			// makes the ancestor bind actually pay off.
			expect(grant.env.PNPM_CONFIG_STORE_DIR).toBe(store);
		});

		it("grants the shared git dir writable so git commit/branch work", () => {
			const shared = path.join(root, "repos", "acme.git");
			mkdirSync(shared, { recursive: true });
			writeWorktreeGitPointer(worktree, shared);

			expect(resolveSandboxGrant(worktree).writablePaths).toContain(shared);
		});

		it("degrades without throwing when the git common dir is unresolvable", () => {
			// No `.git` in the worktree at all: the Session still gets a usable
			// sandbox, just without the shared-git-dir grant.
			const grant = resolveSandboxGrant(worktree);

			expect(grant.writablePaths).toContain(worktreesDir);
			expect(grant.writablePaths.some((p) => p.endsWith(".git"))).toBe(false);
		});

		it("includes the toolchain state dirs, all rooted under the data dir", () => {
			const grant = resolveSandboxGrant(worktree);
			const toolchainHome = path.join(dataDir, "toolchain-home");

			expect(grant.writablePaths).toContain(
				path.join(toolchainHome, "mise", "data"),
			);
			expect(grant.writablePaths).toContain(
				path.join(toolchainHome, "gh-config"),
			);
			// Rooted under DILNA_DATA_DIR rather than $HOME (issue #83) so it
			// survives a pod restart.
			for (const p of grant.writablePaths) {
				if (p.startsWith(toolchainHome)) continue;
				if (p === worktreesDir) continue;
				// Only the platform temp scratch parent is allowed to sit outside.
				expect(p.startsWith(tmpdir())).toBe(true);
			}
		});

		it("masks every sibling session's worktree from reads", () => {
			const sibling = path.join(worktreesDir, "acme-repo", "session-other");
			mkdirSync(sibling, { recursive: true });

			const grant = resolveSandboxGrant(worktree);

			expect(grant.denyReadPaths).toContain(sibling);
			expect(grant.denyReadPaths).not.toContain(worktree);
		});

		describe("when the data dir is nested inside dilna's own checkout", () => {
			it("denies read on the checkout root but keeps the worktree readable", () => {
				// The local-dev shape: DILNA_DATA_DIR=./data inside dilna's own
				// repo. Without the deny, a Session's bash could wander into
				// dilna's own source; without re-allowing reads over the writable
				// set, the deny would swallow the worktree itself (which lives
				// under the denied root).
				const checkout = root;
				writeFileSync(
					path.join(checkout, "pnpm-workspace.yaml"),
					"packages:\n",
				);
				const moduleDir = path.join(checkout, "apps", "server", "src");
				mkdirSync(moduleDir, { recursive: true });

				const grant = resolveSandboxGrant(worktree, moduleDir);

				expect(grant.nestedInCheckout).toBe(true);
				expect(grant.denyReadPaths).toContain(checkout);
				// The worktree is reached through the worktrees-dir ancestor,
				// which is granted read (allowRead === writablePaths in pi.ts's
				// wrapWithSandbox call) — that's what re-opens it within the deny.
				expect(grant.writablePaths).toContain(worktreesDir);
				expect(worktree.startsWith(`${worktreesDir}${path.sep}`)).toBe(true);
			});
		});

		describe("when the data dir is outside dilna's checkout", () => {
			it("denies nothing beyond siblings", () => {
				// The deployed shape: a data volume with no pnpm-workspace.yaml
				// anywhere above the module dir, so there is no checkout to mask.
				const moduleDir = path.join(root, "elsewhere", "dist");
				mkdirSync(moduleDir, { recursive: true });

				const grant = resolveSandboxGrant(worktree, moduleDir);

				expect(grant.nestedInCheckout).toBe(false);
				expect(grant.denyReadPaths).toEqual([]);
			});
		});
	});

	describe("toolchainEnv", () => {
		it("forces hardlink import instead of trusting pnpm's own auto probe", () => {
			// pnpm's "auto" detection probes TMPDIR — a different bwrap mount
			// than the store — and concludes "can't hardlink", producing copies.
			expect(toolchainEnv(worktree).PNPM_CONFIG_PACKAGE_IMPORT_METHOD).toBe(
				"hardlink",
			);
		});

		it("uses the PNPM_CONFIG_* family, never the inert npm_config_* one", () => {
			// `npm_config_store_dir` is silently ignored by pnpm; this was
			// live-broken in production until corrected.
			const env = toolchainEnv(worktree);

			expect(env.PNPM_CONFIG_STORE_DIR).toBeDefined();
			expect(env.npm_config_store_dir).toBeUndefined();
			expect(env.npm_config_package_import_method).toBeUndefined();
		});

		it("prepends mise's real shims dir so a bare pnpm skips node's corepack shim", () => {
			const env = toolchainEnv(worktree);
			const shims = path.join(
				dataDir,
				"toolchain-home",
				"mise",
				"data",
				"shims",
			);

			expect(env.PATH?.startsWith(`${shims}:`)).toBe(true);
			// The inherited PATH is kept behind it, not replaced.
			expect(env.PATH).toContain(process.env.PATH ?? "");
		});

		it("trusts the worktree's own mise config, appending to any inherited list", () => {
			expect(toolchainEnv(worktree).MISE_TRUSTED_CONFIG_PATHS).toContain(
				worktree,
			);
		});

		it("points every mise/XDG/gh dir under the data dir's toolchain home", () => {
			const env = toolchainEnv(worktree);
			const toolchainHome = path.join(dataDir, "toolchain-home");

			expect(env.MISE_DATA_DIR).toBe(path.join(toolchainHome, "mise", "data"));
			expect(env.MISE_CACHE_DIR).toBe(
				path.join(toolchainHome, "mise", "cache"),
			);
			expect(env.XDG_CACHE_HOME).toBe(path.join(toolchainHome, "cache"));
			expect(env.XDG_DATA_HOME).toBe(path.join(toolchainHome, "xdg-data"));
			expect(env.XDG_CONFIG_HOME).toBe(path.join(toolchainHome, "xdg-config"));
			expect(env.GH_CONFIG_DIR).toBe(path.join(toolchainHome, "gh-config"));
		});

		it("defers to an already-set override in the process env", () => {
			// afterEach restores whatever the ambient value was.
			process.env.MISE_CACHE_DIR = "/custom/mise-cache";
			process.env.PNPM_CONFIG_STORE_DIR = "/custom/store";

			const env = toolchainEnv(worktree);

			expect(env.MISE_CACHE_DIR).toBe("/custom/mise-cache");
			expect(env.PNPM_CONFIG_STORE_DIR).toBe("/custom/store");
		});
	});

	describe("ensureWritablePathsExist", () => {
		it("pre-creates every granted path, since bwrap skips binding a missing one", () => {
			ensureWritablePathsExist();

			const grant = resolveSandboxGrant(worktree);
			for (const p of grant.writablePaths) {
				// The worktrees dir and toolchain dirs must all exist; a bwrap
				// write grant is a silent no-op against a nonexistent host source.
				expect(
					existsSync(p),
					`expected granted writable path to exist: ${p}`,
				).toBe(true);
			}
		});

		it("creates the pnpm store even though it is never granted directly", () => {
			ensureWritablePathsExist();

			expect(existsSync(path.join(worktreesDir, ".pnpm-store"))).toBe(true);
		});
	});
});
