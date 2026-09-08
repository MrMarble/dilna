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

Not independently re-verified inside the real container
(`DILNA_CONTAINERIZED=true`, `enableWeakerNestedSandbox`) at the time this
section was first written — matching ADR-0010's own Verification section,
which flagged the same gap for the original sandbox adoption. That gap
turned out to matter: re-verified since, by building dilna's actual Docker
image and running it with production's `seccomp-bubblewrap.json` profile —
see Follow-up 2 below, which found and fixed a real bug (pnpm's own hardlink
auto-detection) that only surfaced there, not in this bare-host mechanism
test. This bare-`bwrap` result was correct as far as it went (the mount
topology genuinely behaves as tested), it just wasn't the whole picture; the
prediction made here at the time ("not expected to behave differently
there") was wrong.

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

## Follow-up: the mount-topology fix alone didn't work — `npm_config_store_dir` is inert for pnpm

Reported still reproducing after this fix shipped, by a real Session working
against the deployed pod: `pnpm store path` reported pnpm's own
`$XDG_DATA_HOME/pnpm/store` default (`toolchain-home/xdg-data/pnpm/store/v11`),
not `PNPM_STORE_DIR`'s new location, despite `toolchainEnv()` already setting
`npm_config_store_dir` to point there. The Session's own investigation
(hardlinking *within* that XDG-derived store succeeded — link count 2 — but
hardlinking from it *into* the worktree failed `EXDEV`) independently
rediscovered this ADR's core mechanism from scratch, correctly, before
landing on the wrong root cause ("the two paths aren't really on the same
mount despite matching `stat -c %d`" — true, but the fixable part was which
store path pnpm was even using).

Root cause, confirmed directly against a real `pnpm` outside dilna's code
(`env -i ... npm_config_store_dir=<path> pnpm config get store-dir` → prints
`undefined`, vs. `npm_config_registry=<url> pnpm config get registry` →
correctly overridden): unlike every other config key `toolchainEnv()` sets
this way, pnpm's `store-dir` does not honor the shared `npm_config_*`
environment-variable convention at all — `PNPM_STORE_DIR`'s relocation
(Decision, above) was therefore having zero effect in production; the
sandboxed bash tool's `pnpm` was always resolving its store from
`XDG_DATA_HOME`, itself bound as its own separate bwrap mount, so `EXDEV`
never went away.

The actually-honored variable, confirmed the same way: `PNPM_CONFIG_STORE_DIR`.
`pnpm store path` picks it up immediately, and — checked with a real
`pnpm install` of a real package, run through the identical
`SandboxManager.initialize`/`wrapWithSandbox` code path `pi.ts` uses, with
`PNPM_CONFIG_STORE_DIR` set to a store nested under the bound ancestor — every
installed file in `node_modules/.pnpm` came back with link count 2 (store and
worktree entry), not 1. This is the same class of gap ADR-0010's own
Follow-ups document repeatedly (a grant or a redirect that's *inert* rather
than wrong, so it fails silently and looks like something else): the
mount-topology diagnosis and fix in this ADR's main text were both correct,
they just never reached pnpm because the env var carrying `PNPM_STORE_DIR`'s
value to it was never the one pnpm reads.

Fixed by changing `toolchainEnv()` (`pi.ts`) to set `PNPM_CONFIG_STORE_DIR`
instead of `npm_config_store_dir`. No other part of the Decision changes —
`PNPM_STORE_DIR`'s value and the `WORKTREES_DIR` ancestor-bind/sibling-mask
mechanism were already correct; only the variable name carrying the value
into the sandboxed process was wrong.

The `PNPM_CONFIG_STORE_DIR` fix above was itself only verified on a bare
dev host, not inside dilna's actual container — the exact gap this ADR's
Verification section already flagged as open. Closing it turned up a third,
independent bug (next Follow-up), so treat this section's own "fixed" as
provisional; it was correct but insufficient on its own.

## Follow-up 2: still copying inside the real container — pnpm's own hardlink auto-detection is a false negative here

Verified by building dilna's actual Docker image and running it with the
same `seccomp-bubblewrap.json` profile `docker-compose.yml` uses (the exact
gap the original Verification section left open — bare-host `bwrap` isn't
the same as bwrap inside an unprivileged container with
`enableWeakerNestedSandbox: true` and dilna's egress-proxy seccomp filter
layered on top). A real `pnpm install` against a Docker anonymous volume at
`/data` (same shape as the production Longhorn PVC: one separate mount,
`WORKTREES_DIR` and the store both nested under it), through the identical
`SandboxManager.wrapWithSandbox` code path with `PNPM_CONFIG_STORE_DIR`
correctly set (confirmed: store populated at the intended path, not the old
XDG default) — still came back with every installed file at link count 1.
Copying, still, despite both Follow-ups above being individually correct and
individually verified.

Isolated by testing progressively closer to what pnpm itself does, all
through the identical wrapped sandbox command:

1. A plain coreutils `ln` between the store and the worktree — succeeded,
   link count 2.
2. A bare bwrap invocation reproducing the exact `--bind`/`--tmpfs` argument
   shape `wrapWithSandbox` generates (dumped and inspected directly) — also
   succeeded. The generated bwrap arguments for the filesystem portion are
   byte-for-byte identical whether `enableWeakerNestedSandbox` is on or off;
   only the trailing `--proc`/`--cap-drop` handling differs, so neither is
   itself the cause.
3. Node's own `fs.linkSync` between the same two paths, run inside the same
   wrapped sandbox (ruling out the layered seccomp filter — `vendor/seccomp/
   .../apply-seccomp` — blocking the syscall specifically for Node) —
   succeeded, `nlink: 2`.
4. `pnpm install --package-import-method=hardlink` (forcing the method
   instead of pnpm's default `auto`) — succeeded, link count 2, same
   environment, same store, same everything else.

So the mechanism this ADR built (mount topology, then the right env var to
reach pnpm) is sound end-to-end — every direct probe succeeds — but pnpm's
own `auto` capability detection decides "copy" anyway. Not confirmed against
pnpm's own source, but the shape strongly suggests the probe runs against
`TMPDIR` rather than against the real worktree: `sandbox-runtime` forces
`TMPDIR` to its own default write path (`SANDBOX_DEFAULT_WRITE_PATHS`'s doc
comment in `pi.ts`), which is its own separate `allowWrite` entry and
therefore its own separate bwrap mount — genuinely cross-mount from the
store, unlike the real worktree. If pnpm's auto-probe tests
store-to-`TMPDIR` rather than store-to-target, it would correctly observe
`EXDEV` for that pair and wrongly generalize "hardlinking doesn't work here"
for every pair, including the one that actually matters.

Fixed by adding `PNPM_CONFIG_PACKAGE_IMPORT_METHOD: "hardlink"` to
`toolchainEnv()` (`pi.ts`), forcing the method instead of trusting the
auto-detection — verified (same containerized setup, same
`PNPM_CONFIG_STORE_DIR`, no CLI flag, purely via the two env vars
`toolchainEnv()` now sets) to produce link count 2 with a clean install and
no errors. This is a deliberate a-priori override, not a workaround pending
a better fix: `PNPM_STORE_DIR`'s doc comment already establishes "store and
worktree always share one mount" as an invariant this code maintains by
construction, so skipping a probe that can't see that invariant and forcing
the method it should have chosen anyway costs nothing. `PNPM_CONFIG_STORE_DIR`
was checked for the same `PNPM_CONFIG_*` vs. `npm_config_*` split from
Follow-up 1 (`npm_config_package_import_method` is equally inert) before
settling on this one.
