import {
	type Dirent,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDefaultWritePaths } from "@anthropic-ai/sandbox-runtime";
import { getDataDir } from "../db";

/**
 * Worktree sandbox and toolchain policy — everything about *what a Session's
 * sandboxed bash may touch and with which toolchain env*, extracted from
 * `agents/pi.ts` (issue #177) so it can be tested without constructing an
 * `Agent`.
 *
 * The seam is deliberately a **value**, not a callback: {@link resolveSandboxGrant}
 * takes a Worktree path and returns the writable paths, deny-read paths and
 * toolchain env as plain data, so the whole policy can be asserted against a
 * `mkdtemp` directory tree with no `Agent`, no bwrap and no LLM in play.
 * `pi.ts`'s `startPi` then reads as: resolve the grant, build tools with it,
 * construct the `Agent`. `confinement.ts` (extracted from the same file) is
 * the in-repo precedent for this shape.
 *
 * ADR-0010 (sandboxing), ADR-0012 (mise toolchain) and ADR-0027-pnpm-store
 * (store hardlinking) are unchanged by the extraction — only *where* they're
 * implemented. The doc comments below carry the incident history each grant
 * exists for; several are load-bearing invariants that were established
 * empirically and are silent when broken, so read them before changing a
 * path or an env var here.
 *
 * Nothing in this module is memoized at import time: every path is derived
 * from {@link getDataDir} per call, since `DILNA_DATA_DIR` is read fresh on
 * each `getDataDir()` (and a test — or an isolated instance — points it
 * somewhere else). The one exception is process-wide sandbox init, which is
 * once-per-process by `SandboxManager`'s own contract; it lives in `pi.ts`
 * beside the `Agent` construction it gates, not here.
 */

/** Name reserved directly under the worktrees dir, alongside every repo's
 * `<slug>/` directory, for the shared pnpm store below.
 * {@link listSiblingWorktreeDirs} skips it by this exact name so it's never
 * mistaken for a repo slug and masked as a sibling session. */
const SHARED_PNPM_STORE_DIRNAME = ".pnpm-store";

/**
 * Every path this module derives from a given data dir. Grouped into one
 * resolver (rather than module-level constants, as in pi.ts before this
 * extraction) so a test can point `DILNA_DATA_DIR` at a scratch tree and get
 * a fully consistent set of paths under it.
 *
 * `toolchainHome` is the root for every toolchain's per-user
 * install/cache/config state (ADR-0012, issue #83): rooted under
 * `DILNA_DATA_DIR` rather than `$HOME` so it survives a pod restart.
 *
 * `worktreesDir` mirrors `repos/manager.ts`'s identical
 * `worktreesDir`/`worktreeBase` layout (`<slug>/<session-id>`). Recomputed
 * here rather than imported to keep the sandbox wiring self-contained; must
 * stay in sync with that layout.
 */
function resolveSandboxPaths(dataDir: string) {
	const toolchainHome = path.join(dataDir, "toolchain-home");
	const xdgCacheHome = path.join(toolchainHome, "cache");
	const worktreesDir = path.join(dataDir, "worktrees");
	return {
		toolchainHome,
		miseDataDir: path.join(toolchainHome, "mise", "data"),
		miseConfigDir: path.join(toolchainHome, "mise", "config"),
		miseCacheDir: path.join(toolchainHome, "mise", "cache"),
		miseStateDir: path.join(toolchainHome, "mise", "state"),
		xdgCacheHome,
		xdgDataHome: path.join(toolchainHome, "xdg-data"),
		xdgConfigHome: path.join(toolchainHome, "xdg-config"),
		ghConfigDir: path.join(toolchainHome, "gh-config"),
		worktreesDir,
		/**
		 * Deliberately nested under `worktreesDir`, not `toolchainHome` — and
		 * deliberately never listed on its own in any `filesystem.allowWrite`/
		 * `allowRead` array passed to `wrapWithSandbox` (see
		 * {@link toolchainWritablePaths}, which excludes it for exactly this
		 * reason).
		 *
		 * pnpm's speed comes from hardlinking store files into `node_modules`,
		 * and `link(2)` refuses to cross a mount boundary (`EXDEV`) even when
		 * both sides are the same underlying device — a mount-namespace rule,
		 * not a filesystem one. `sandbox-runtime`'s bwrap wrapper turns every
		 * entry in `filesystem.allowWrite` into its own identity bind
		 * (`--bind path path` against a `--ro-bind / /` root — confirmed by
		 * reading the installed `linux-sandbox-utils.js` directly), so two
		 * *separately listed* writable paths are always siblings in the mount
		 * table, never the same mount, no matter where they live on the host.
		 * That's why a store under `toolchainHome` degraded every `pnpm
		 * install` in this sandbox to a full byte-for-byte copy (confirmed:
		 * store files and their `node_modules/.pnpm` counterparts both had
		 * link count 1) despite `df`/`stat -c %d` reporting the same device on
		 * both sides.
		 *
		 * The fix relies on the flip side of the same rule, verified directly
		 * with `bwrap` outside of dilna's code before writing this: a plain
		 * host subdirectory reached *through* an already-bound ancestor (no
		 * bind of its own) shares that ancestor's single mount, so `link()`
		 * between two such subdirectories succeeds — but re-adding an explicit
		 * `--bind` on either subdirectory (even redundantly, even though it's
		 * already reachable through the ancestor) immediately reintroduces
		 * `EXDEV`, since bwrap always creates a fresh mount entry for a bind
		 * target regardless of what already covers it. So the grant binds
		 * `worktreesDir` itself as the one writable ancestor and reaches both
		 * this store and the Worktree as its plain, never-separately-bound
		 * children — never list either of those two paths in
		 * `filesystem.allowWrite`/`allowRead` directly, or the EXDEV
		 * regression comes back for whichever one gets listed. The
		 * `omits the pnpm store and the worktree` test in this module's suite
		 * is what guards that.
		 *
		 * The corresponding isolation cost — this session's bash can now reach
		 * every *sibling* worktree under `worktreesDir`, not just its own,
		 * since they all share the one ancestor bind — is paid back by
		 * {@link listSiblingWorktreeDirs}, which enumerates and `denyRead`s
		 * every sibling session directory individually. This deliberately does
		 * NOT use ADR-0010's usual "`denyRead` the whole ancestor, then
		 * `allowRead`/`allowWrite` re-expose the one nested path" pattern:
		 * that pattern re-binds the reallowed path as its own separate mount
		 * to make it accessible again (same `linux-sandbox-utils.js`,
		 * `pushReadDenyDirMounts`'s `--bind`/`--ro-bind` re-application) —
		 * i.e. it reproduces the exact EXDEV-causing shape this whole design
		 * exists to avoid. Masking siblings individually instead keeps the
		 * Worktree and this store as untouched, un-re-bound children of the
		 * one ancestor mount.
		 */
		pnpmStoreDir: path.join(worktreesDir, SHARED_PNPM_STORE_DIRNAME),
	};
}

// NOT redirected here on purpose: `PI_CODING_AGENT_DIR` (where
// pi-coding-agent's grep/find tools self-download rg/fd if neither is on
// PATH, per those tools' own `getBinDir()`) can't go through
// `toolchainEnv()` below like the vars above do. `toolchainEnv()` only
// reaches the sandboxed bash tool's own subprocess — a different process
// from this server, which is what actually runs grep/find — and
// pi-coding-agent's `tools-manager.js` caches its resolved bin dir as a
// module-level constant read once at import time, before any of this
// module's own code (`toolchainEnv()` included) ever runs. It has to be a
// real env var on the server process itself before `node` starts: set in
// `docker-entrypoint.sh` (derived from `DILNA_DATA_DIR`, mirroring
// `toolchainHome` here). Not set for local dev (no `mise.toml` `[env]`
// entry) — `pnpm --filter @dilna/server run dev` runs with cwd
// `apps/server/`, not the repo root `getDataDir()` resolves relative
// `DILNA_DATA_DIR` values against, and pi-coding-agent's own path normalizer
// has no equivalent repo-root-walking logic, so a naive relative value here
// would land in the wrong place; local dev's plain `$HOME` doesn't need the
// redirect anyway; it only vanishes on a *pod* restart.

/**
 * Own scratch parent for ad-hoc temp-file use (a one-off script, `mktemp`,
 * etc.) when a bash call happens to run with the sandbox disabled — mirrors
 * `claude.ts`'s identical `CLI_SCRATCH_PARENT_DIR`. Irrelevant to the
 * sandboxed path: bwrap's own `--setenv TMPDIR ...` (baked into the wrapped
 * command by `sandbox-runtime` itself, from its
 * `CLAUDE_CODE_TMPDIR`/`CLAUDE_TMPDIR` env var or else its hardcoded
 * `/tmp/claude` default — see `generateProxyEnvVars` in the installed
 * `sandbox-utils.js`) always wins over whatever `TMPDIR` this process's own
 * env carries, so setting it here only helps the non-sandboxed fallback.
 */
const CLI_SCRATCH_PARENT_DIR = path.join(
	os.tmpdir(),
	`claude-${process.getuid?.() ?? 0}`,
);

/**
 * `sandbox-runtime`'s own default write-path allowlist
 * (`getDefaultWritePaths()`, e.g. `/tmp/claude`) is what it points `TMPDIR`
 * at *inside* every sandboxed command via bwrap's `--setenv` — but it never
 * creates that directory on the host itself, and bwrap silently skips
 * binding a write path whose host source doesn't exist (confirmed in the
 * installed `linux-sandbox-utils.js`'s write-path loop). Since nothing else
 * in dilna ever creates `/tmp/claude` either, every sandboxed command
 * inherits a `TMPDIR` that resolves to a nonexistent, unwritable path — and
 * any tool that touches `$TMPDIR` at startup (pnpm's `temp-dir` package
 * `lstat`s it before anything else runs) fails outright with an
 * `ENOENT`/`EROFS` that reads nothing like a temp-dir problem. This dropped
 * out when `claude.ts` (which had the equivalent gap for its own
 * `CLAUDE_SCRATCH_WRITABLE_PATHS`, a *different* directory than
 * sandbox-runtime's own default) was replaced by `pi.ts` and broke `pnpm
 * install` for every session needing to install dependencies (issue debugged
 * 2026-08-28: three orchestrator sessions all hit this via pnpm and
 * misdiagnosed it as "no network"). Pre-creating sandbox-runtime's own
 * default paths in {@link ensureWritablePathsExist} — rather than trying to
 * redirect `TMPDIR` — is what actually reaches the sandboxed child, since
 * it's the exact path bwrap already binds writable and points `TMPDIR` at
 * with no further config needed.
 */
const SANDBOX_DEFAULT_WRITE_PATHS = getDefaultWritePaths();

/** The toolchain state dirs granted writable to sandboxed bash.
 *
 * The pnpm store dir is deliberately NOT here — see its own doc comment in
 * {@link resolveSandboxPaths}. It still needs pre-creating
 * ({@link ensureWritablePathsExist} adds it explicitly) but must never appear
 * in the `filesystem.allowWrite`/`allowRead` array built from this list, or
 * it gets its own bwrap bind and the EXDEV regression that comment describes
 * comes right back. The Worktree path itself is absent for the same reason. */
function toolchainWritablePaths(dataDir: string): string[] {
	const p = resolveSandboxPaths(dataDir);
	return [
		p.miseDataDir,
		p.miseConfigDir,
		p.miseCacheDir,
		p.miseStateDir,
		p.xdgCacheHome,
		path.join(p.xdgCacheHome, "sigstore-rust"),
		p.xdgDataHome,
		p.xdgConfigHome,
		p.ghConfigDir,
		path.join(p.xdgCacheHome, "gh"),
		CLI_SCRATCH_PARENT_DIR,
	];
}

/**
 * A git worktree's `.git` is a file pointing at metadata under the origin
 * repo's actual git dir, whose `commondir` in turn points at the *shared* git
 * dir (objects/refs/config). Sandboxed bash needs write access to that shared
 * dir directly — `git commit`/`git branch` fail read-only against it
 * otherwise.
 *
 * Returns `null` (rather than throwing) for anything unexpected — a plain
 * non-worktree checkout whose `.git` is a real directory, a missing
 * `commondir`, an unreadable path. A Session whose git layout can't be
 * resolved still gets a working sandbox, just without the shared-git-dir
 * grant; that degrades `git commit` rather than failing Session start.
 */
export function resolveGitCommonDir(worktreePath: string): string | null {
	try {
		const dotGit = readFileSync(path.join(worktreePath, ".git"), "utf8");
		const match = dotGit.match(/^gitdir:\s*(.+)$/m);
		const worktreeGitDir = match?.[1]?.trim();
		if (!worktreeGitDir) return null;
		const commondir = readFileSync(
			path.join(worktreeGitDir, "commondir"),
			"utf8",
		).trim();
		return path.resolve(worktreeGitDir, commondir);
	} catch {
		return null;
	}
}

/**
 * Every other session's worktree directory under `worktreesDir`
 * (`<slug>/<session-id>`, per `repos/manager.ts`'s layout), excluding
 * `ownWorktreePath` and the shared pnpm store. The grant masks each of these
 * from the sandboxed bash tool's reads via `denyRead` — see the pnpm store's
 * doc comment in {@link resolveSandboxPaths} for why this enumeration
 * (rather than ADR-0010's usual deny-ancestor/reallow-one-child pattern) is
 * what pays back the isolation cost of binding the whole `worktreesDir`
 * ancestor writable.
 *
 * Best-effort by design: a session directory created or removed after this
 * runs (concurrent session create/delete elsewhere in the same dilna
 * instance) is missed until the next Bash tool call recomputes this list —
 * matches `wrapWithSandbox`'s own per-call re-evaluation of `customConfig`,
 * so the gap is at most one Bash call wide, not session-lifetime wide. A
 * repo or session directory that vanishes between the `readdirSync` here and
 * bwrap actually applying the resulting `denyRead` is harmless: `denyRead`
 * silently skips a path that no longer exists (confirmed by reading
 * `linux-sandbox-utils.js`'s own denyRead loop).
 */
export function listSiblingWorktreeDirs(
	worktreesDir: string,
	ownWorktreePath: string,
): string[] {
	const siblings: string[] = [];
	let repoEntries: Dirent[];
	try {
		repoEntries = readdirSync(worktreesDir, { withFileTypes: true });
	} catch {
		return siblings;
	}
	for (const repoEntry of repoEntries) {
		if (
			!repoEntry.isDirectory() ||
			repoEntry.name === SHARED_PNPM_STORE_DIRNAME
		)
			continue;
		const repoDir = path.join(worktreesDir, repoEntry.name);
		let sessionEntries: Dirent[];
		try {
			sessionEntries = readdirSync(repoDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const sessionEntry of sessionEntries) {
			if (!sessionEntry.isDirectory()) continue;
			const sessionDir = path.join(repoDir, sessionEntry.name);
			if (sessionDir !== ownWorktreePath) siblings.push(sessionDir);
		}
	}
	return siblings;
}

/**
 * Walk up from `start` to find dilna's own monorepo root (marked by
 * `pnpm-workspace.yaml`) — mirrors `db/index.ts`'s identical helper, used to
 * detect whether `DILNA_DATA_DIR` lives nested inside dilna's own checkout,
 * so a session's tools don't accidentally pick up dilna's own project files
 * while confined to someone else's worktree.
 */
export function findWorkspaceRoot(start: string): string {
	let dir = start;
	while (true) {
		if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
		const parent = path.dirname(dir);
		if (parent === dir) return start;
		dir = parent;
	}
}

/** Toolchain env vars injected into every sandboxed bash call — see
 * `claude.ts`'s identical env block for why each one is needed.
 *
 * `PATH`: the Dockerfile bakes `/home/node/.local/share/mise/shims` onto
 * `PATH` (ADR-0012's "shim-based activation"), but that's mise's *default*
 * shims dir under plain `$HOME` — dead since issue #83 redirected
 * `MISE_DATA_DIR` (and therefore mise's real shims dir) to
 * `toolchainHome`/`DILNA_DATA_DIR` instead. It's real: with no shims dir for
 * the *actual* `MISE_DATA_DIR` ever on `PATH`, a bare `pnpm`/`node`/etc.
 * resolves to nothing (`command not found`), pushing agents onto `mise exec
 * -- pnpm ...` — which itself doesn't reliably pick the mise-installed
 * binary either; observed live falling through to the *base* node install's
 * bundled corepack shim instead (`installs/node/<version>/lib/node_modules/corepack`),
 * which then tries to download pnpm from registry.npmjs.org and fails in a
 * network-restricted deployment. Prepending the real shims dir here is the
 * fix `mkdir -p`-side ({@link ensureWritablePathsExist} creates the dir mise
 * populates once a tool's `mise install` has actually run); it also sorts
 * ahead of the corepack-shimmed `pnpm` in the mise-installed node's own bin
 * dir, so once a real shim exists here it wins PATH resolution instead of
 * corepack's.
 *
 * Every var defers to an already-set value in `process.env` (`??`) so an
 * operator or an isolated dev instance can override any single one without
 * patching code — except `MISE_TRUSTED_CONFIG_PATHS` and `PATH`, which
 * *append to* / *prepend to* the inherited value rather than replacing it.
 */
export function toolchainEnv(worktreePath: string): NodeJS.ProcessEnv {
	const p = resolveSandboxPaths(getDataDir());
	return {
		MISE_TRUSTED_CONFIG_PATHS: [
			process.env.MISE_TRUSTED_CONFIG_PATHS,
			worktreePath,
		]
			.filter(Boolean)
			.join(":"),
		PATH: [path.join(p.miseDataDir, "shims"), process.env.PATH]
			.filter(Boolean)
			.join(":"),
		// NOT `npm_config_store_dir`, despite that being the convention every
		// other pnpm/npm-shared config key in this function follows (confirmed
		// working for e.g. `registry` via the same `npm_config_*` mechanism).
		// Verified directly, outside dilna's code: `pnpm config get store-dir`
		// stays `undefined` under `npm_config_store_dir`, no matter what else is
		// set, while `PNPM_CONFIG_STORE_DIR` is honored immediately by both
		// `pnpm store path` and a real `pnpm install` (installed files came back
		// hardlinked — link count 2 — against a store placed via this var). This
		// was live-broken in production: `pnpm store path` inside a real Session
		// reported pnpm's own XDG-derived default (`$XDG_DATA_HOME/pnpm/store`,
		// itself a separate bwrap mount from the worktrees dir — see the pnpm
		// store's doc comment in `resolveSandboxPaths`), never this value, so
		// the ancestor-bind fix there had zero effect until this line was
		// corrected.
		PNPM_CONFIG_STORE_DIR: process.env.PNPM_CONFIG_STORE_DIR ?? p.pnpmStoreDir,
		// pnpm's own "auto" hardlink-capability detection (the unset default)
		// is unreliable in this sandbox: it produced copies (link count 1) even
		// once `PNPM_CONFIG_STORE_DIR` correctly pointed at a store colocated
		// with the worktree on one bwrap mount, verified working via a plain
		// `ln`/`fs.linkSync` between the exact same two paths in the same
		// sandboxed process. The likely reason (not confirmed against pnpm's
		// source, only observed): its probe most plausibly runs against
		// `TMPDIR` rather than the real worktree — `sandbox-runtime` forces
		// `TMPDIR` to its own default write path (see
		// `SANDBOX_DEFAULT_WRITE_PATHS`'s doc comment), which is its own
		// separate bwrap mount, genuinely cross-mount from the store — so
		// "auto" isn't wrong about that pair, just testing the wrong one.
		// Forcing `hardlink` here skips the unreliable probe and relies
		// directly on the invariant the pnpm store's doc comment establishes
		// (store and worktree always share one mount); confirmed fixing it
		// (link count 2) against the exact same environment that reproduced
		// the copy. Same `PNPM_CONFIG_*` env-var family as
		// `PNPM_CONFIG_STORE_DIR` above — `npm_config_package_import_method` is
		// equally inert, checked the same way.
		PNPM_CONFIG_PACKAGE_IMPORT_METHOD:
			process.env.PNPM_CONFIG_PACKAGE_IMPORT_METHOD ?? "hardlink",
		MISE_DATA_DIR: process.env.MISE_DATA_DIR ?? p.miseDataDir,
		MISE_CONFIG_DIR: process.env.MISE_CONFIG_DIR ?? p.miseConfigDir,
		MISE_CACHE_DIR: process.env.MISE_CACHE_DIR ?? p.miseCacheDir,
		MISE_STATE_DIR: process.env.MISE_STATE_DIR ?? p.miseStateDir,
		XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? p.xdgCacheHome,
		XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? p.xdgDataHome,
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? p.xdgConfigHome,
		GH_CONFIG_DIR: process.env.GH_CONFIG_DIR ?? p.ghConfigDir,
		// Only takes effect when a bash call runs with the sandbox disabled —
		// see CLI_SCRATCH_PARENT_DIR's doc comment for why the sandboxed path
		// needs a different fix (SANDBOX_DEFAULT_WRITE_PATHS).
		TMPDIR: process.env.TMPDIR ?? CLI_SCRATCH_PARENT_DIR,
	};
}

/** A writable-path grant only does anything once the host directory already
 * exists (see `claude.ts`'s identical note) — pre-create every leaf before
 * the sandboxed bash tool's first use. Sandbox-runtime's own default write
 * paths are included too (see `SANDBOX_DEFAULT_WRITE_PATHS`'s doc comment);
 * a leaf irrelevant to this platform (e.g. `/private/tmp/claude` on Linux)
 * fails harmlessly and is skipped rather than aborting the others. The pnpm
 * store dir is created here too, even though (unlike every other leaf in
 * this function) it's never passed to the sandbox directly — see its own doc
 * comment in {@link resolveSandboxPaths} for why. */
export function ensureWritablePathsExist(): void {
	const dataDir = getDataDir();
	const p = resolveSandboxPaths(dataDir);
	for (const dir of [
		...toolchainWritablePaths(dataDir),
		p.pnpmStoreDir,
		...SANDBOX_DEFAULT_WRITE_PATHS,
	]) {
		try {
			mkdirSync(dir, { recursive: true });
		} catch {}
	}
}

/**
 * The sandbox grant for one Session's Worktree: the complete filesystem and
 * toolchain policy its sandboxed bash runs under, as plain data.
 *
 * This is the module's whole interface — `startPi` resolves one of these and
 * hands its three fields straight to `wrapWithSandbox`'s `customConfig` and
 * the bash tool's env. Being a value rather than a callback is what makes
 * the policy assertable in a unit test (see `worktreeSandbox.test.ts`).
 */
export type SandboxGrant = {
	/** Passed as both `filesystem.allowWrite` and `filesystem.allowRead`.
	 * Read access is granted over the same set so the Worktree stays readable
	 * within the broader `denyRead` when it happens to be nested inside
	 * dilna's own checkout (see {@link denyReadPaths}). */
	writablePaths: string[];
	/** Masked from reads: dilna's own checkout when the data dir is nested
	 * inside it, plus every *sibling* Session's Worktree (the isolation cost
	 * of binding the whole worktrees dir as one writable ancestor). */
	denyReadPaths: string[];
	/** Env vars layered onto every sandboxed bash call. */
	env: NodeJS.ProcessEnv;
	/** Whether the data dir lives nested inside dilna's own checkout — drives
	 * the deny-read above, and `startPi` also appends a note to the system
	 * prompt when true (the agent otherwise sees dilna's own project files in
	 * an ancestor and gets confused about which repo it's working on). */
	nestedInCheckout: boolean;
};

/**
 * Resolve the {@link SandboxGrant} for a Worktree. Pure with respect to
 * everything except the filesystem it inspects (`DILNA_DATA_DIR` via
 * {@link getDataDir}, the Worktree's `.git`, the sibling enumeration) and
 * `process.env` for the toolchain-env overrides — no `Agent`, no bwrap, no
 * side effects beyond that. Call {@link ensureWritablePathsExist} separately
 * before handing a grant to the sandbox; the split keeps this resolver
 * side-effect-free and therefore safe to assert against a scratch tree.
 *
 * `moduleDir` is the directory the workspace-root walk starts from,
 * defaulting to this module's own location (i.e. dilna's own installed
 * source). A test overrides it to place a synthetic checkout root.
 */
export function resolveSandboxGrant(
	worktreePath: string,
	moduleDir: string = import.meta.dirname,
): SandboxGrant {
	const dataDir = getDataDir();
	const p = resolveSandboxPaths(dataDir);
	const workspaceRoot = findWorkspaceRoot(moduleDir);
	const nestedInCheckout = dataDir.startsWith(`${workspaceRoot}${path.sep}`);
	const gitCommonDir = resolveGitCommonDir(worktreePath);

	// The worktrees dir (not `worktreePath`) is the writable ancestor bound
	// into the sandbox — see the pnpm store's doc comment in
	// `resolveSandboxPaths` for why: it's what lets the Worktree and the
	// shared pnpm store share one bwrap mount instead of each getting its own
	// (which is what broke pnpm's hardlinking). `worktreePath` and the store
	// are deliberately absent from this array — they're reached as the
	// worktrees dir's plain children, and listing either on its own would
	// re-bind it as a separate mount.
	const writablePaths = [
		p.worktreesDir,
		...toolchainWritablePaths(dataDir),
		...(gitCommonDir ? [gitCommonDir] : []),
	];

	// Isolation cost of binding the whole worktrees-dir ancestor above: every
	// sibling session's worktree is technically reachable through that same
	// bind too. Paid back by masking each one from reads individually — see
	// `listSiblingWorktreeDirs`'s doc comment for why this can't just be
	// "denyRead worktreesDir, allowRead worktreePath" instead.
	const denyReadPaths = [
		...(nestedInCheckout ? [workspaceRoot] : []),
		...listSiblingWorktreeDirs(p.worktreesDir, worktreePath),
	];

	return {
		writablePaths,
		denyReadPaths,
		env: toolchainEnv(worktreePath),
		nestedInCheckout,
	};
}
