# Share the pnpm store across sessions by binding the worktrees ancestor, not each worktree

## Context

The `toolchain-home/pnpm/store` grant (ADR-0010's `PNPM_STORE_DIR`, extended
for pi in ADR-0020) was meant to make `pnpm install` fast across Sessions: a
shared download cache, so no Session re-fetches a package another Session
already resolved. In practice, installs still took ~4 minutes and wrote
~663MB into every Session's `node_modules`, even reporting a 100% cache hit
(`resolved`/`reused` count matching `downloaded: 0`).

Root cause: pnpm's speed comes from *hardlinking* files out of the store into
`node_modules`, not from the download skip. `link(2)` refuses to cross a
mount boundary (`EXDEV: Invalid cross-device link`) even when both sides are
the same underlying device — a mount-namespace rule, not a filesystem one
(`stat -c %d`/`df` report the same device on both sides; only `ln` reveals
the boundary). `sandbox-runtime`'s bwrap wrapper (the mechanism ADR-0010
adopted) turns every entry of `filesystem.allowWrite` into its own identity
bind — `--bind path path` against a `--ro-bind / /` root, confirmed by
reading the installed `linux-sandbox-utils.js` directly — so `opts.worktreePath`
and `PNPM_STORE_DIR`, passed as two separate `allowWrite` entries, were always
two separate mounts no matter where either lived on the host. Without
hardlinking, pnpm silently degrades to a full byte-for-byte copy per file,
which is the ~4 minutes.

This is dilna's own sandbox construction (`pi.ts`'s `bashWritablePaths`,
wired into `sandbox-runtime` via `wrapWithSandbox`), not a Kubernetes/PVC
layout issue — the pod mounts a single `/data` volume once; every additional
mount boundary visible from inside a Session (per `/proc/self/mountinfo`) is
bwrap's own per-invocation mount namespace, built from this array.

Verified directly with `bwrap` (outside dilna's code, isolating the
mechanism, same approach ADR-0010's own Verification section used) before
changing anything:

- Two separate `--bind` calls for a worktree dir and a store dir (today's
  shape) reproduce `EXDEV` on `ln` between them — confirmed.
- One `--bind` on their *common ancestor*, leaving both as plain,
  never-separately-bound subdirectories, lets `link()` between them succeed
  (link count 2).
- Adding a `--tmpfs` mask over an unrelated *third* subdirectory of that same
  ancestor (simulating hiding a sibling Session) does not disturb the
  hardlink between the other two — masking is per-mountpoint, not
  ancestor-wide.
- Critically, re-adding an explicit `--bind` on *either* of the two paths
  that need to share a mount — even redundantly, even though it's already
  reachable through the ancestor bind — immediately reintroduces `EXDEV`.
  bwrap always creates a fresh mount entry for a bind target regardless of
  what already covers it. This rules out any fix that keeps listing the
  worktree or the store individually in `allowWrite`/`allowRead` alongside a
  broader ancestor grant.

## Decision

In `pi.ts`:

- Move the shared store from `toolchain-home/pnpm/store` to
  `<DILNA_DATA_DIR>/worktrees/.pnpm-store` — a fixed name reserved directly
  under `WORKTREES_DIR`, alongside every repo's `<slug>/` directory
  (`repos/manager.ts`'s existing layout).
- Change the sandboxed bash tool's writable-path list to bind `WORKTREES_DIR`
  itself (not `opts.worktreePath`) as the one ancestor grant. `opts.worktreePath`
  and the store are deliberately never listed on their own — they're reached
  purely as `WORKTREES_DIR`'s plain children, which is what keeps them on one
  mount for `link()` to succeed.
- Pay back the resulting isolation cost — every *sibling* Session's worktree
  is technically reachable through that same ancestor bind now, not just this
  Session's own — with `listSiblingWorktreeDirs`: enumerate
  `WORKTREES_DIR/<slug>/<session-id>` at each Bash call, and `denyRead` every
  one that isn't `opts.worktreePath` (skipping the store by its reserved
  name). Best-effort by design, matching `wrapWithSandbox`'s own per-call
  `customConfig` re-evaluation: a Session created or deleted between one Bash
  call and the next is missed for at most one call, not for the Session's
  whole lifetime.

This deliberately does **not** reuse ADR-0010's established "`denyRead` the
whole ancestor, then `allowRead`/`allowWrite` re-expose the one nested path"
pattern (used there for the checkout-root/worktree case, explicitly *because*
it needs no sibling enumeration). That pattern re-binds the reallowed path as
its own separate mount to make it readable/writable again after the tmpfs
wipe (`linux-sandbox-utils.js`'s `pushReadDenyDirMounts`, the same
`--bind`/`--ro-bind` re-application mechanism) — i.e. it reproduces the exact
EXDEV-causing shape this change exists to eliminate. It's the right tool for
"deny broadly, allow one thing back" when the allowed thing doesn't need to
share a mount with anything else, and the wrong tool here, where the entire
point is that two specific paths *do* need to share a mount. Masking siblings
individually instead leaves `opts.worktreePath` and the store as untouched,
never-re-bound children of the one `WORKTREES_DIR` mount.

## Verification

Beyond the standalone `bwrap` experiments above, re-verified against the
actual code path `pi.ts` now exercises: a script calling
`SandboxManager.initialize`/`wrapWithSandbox` with the exact filesystem
policy shape `startPi` builds (one ancestor `allowWrite`/`allowRead`, one
sibling `denyRead`), executed against a scratch directory standing in for
`WORKTREES_DIR`:

1. `ln <store>/pkg.js <own-worktree>/pkg.js` — succeeds, link count 2 on both
   sides (the actual fix: pnpm's install-time operation).
2. Ordinary read/write inside the own worktree — unaffected.
3. `cat <sibling-worktree>/secret.txt` — fails "No such file or directory"
   (isolation preserved despite the shared ancestor bind).

Not independently re-verified inside the real container (`DILNA_CONTAINERIZED=true`,
`enableWeakerNestedSandbox`) — matches ADR-0010's own Verification section,
which flagged the same gap for the original sandbox adoption. The mechanism
tested here (bwrap bind/tmpfs mount-table behavior) is unrelated to what
`enableWeakerNestedSandbox` changes (`/proc` handling only), so this is not
expected to behave differently there, but it's called out rather than
assumed.

## Consequences

- `pnpm install` in a Session should drop from ~4 minutes / ~663MB written to
  seconds / near-zero additional disk, once the store is warm — the
  reported symptom's fix.
- Concurrent-Session disk pressure on the shared volume drops sharply: the
  ~663MB-per-Session `node_modules` duplication this ADR's Context describes
  was also flagged as a scalability concern, not just a latency one.
- Existing deployments have a stale, now-unused store at the old
  `toolchain-home/pnpm/store` path; no migration is performed; it can be
  deleted manually to reclaim space; the new store repopulates from the
  network on first use, same as the old one did.
- `listSiblingWorktreeDirs` runs a `readdirSync` per repo slug on every Bash
  tool call — cheap at dilna's expected concurrency (a home-lab-scale
  deployment), but a design point worth naming if that changes.
- The isolation model for sandboxed bash is now "ancestor bind + explicit
  per-sibling deny" instead of "bind only what's mine" — a session's bash
  *can* technically write into a sibling's directory tree; that write lands
  in the sibling's `denyRead` tmpfs mask and is discarded rather than failing
  loudly the way writing outside the sandbox's writable set normally does.
  No data crosses between Sessions either way, but the failure mode for an
  agent probing outside its own worktree via Bash is now "silently
  discarded" rather than "read-only filesystem error" — a behavior change
  worth knowing about if it ever needs debugging. The `read`/`write`/`edit`/
  `grep`/`find`/`ls` tools are unaffected: their confinement
  (`confinement.ts`'s `beforeToolCall` hook) is independent of bwrap and
  unchanged by this decision.
