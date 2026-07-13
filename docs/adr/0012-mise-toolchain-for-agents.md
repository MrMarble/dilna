# Give sessions a self-serve toolchain via mise

## Context

In dev, dilna's server shells out to the operator's own host `claude`
install, so a session gets whatever the operator already has on `$PATH` —
not this ADR's concern. Everywhere else (the reference Docker deployment,
ADR-0009), every session runs inside dilna's own container image. That
runtime stage installs exactly what dilna itself needs to serve requests — `git`, `openssh-client`, `ca-certificates`,
`bubblewrap`/`socat` (ADR-0010), `gosu` — plus whatever `node_modules`
`apps/server` imports. It does not install anything for the repos a session
is actually pointed at. A session cloning a Python repo has no `python`; a
Go repo, no `go`; even a Node repo pinned to a different major than dilna's
own build-time `node:24` has no way to get it. Sessions run
`permissionMode: "bypassPermissions"` (ADR-0003) specifically so they can
act autonomously — but "install the toolchain this repo needs, then lint
and test it" is something no session can currently do at all, since the
runtime image also has no root-usable system package manager (the container
runs as the unprivileged `node` user per ADR-0009/0010, and `apt-get`
needs root).

## Decision

Install [mise](https://mise.jdx.dev) in the runtime image as a single
static binary, fetched once in the build stage — pinned to a specific
version via `ARG MISE_VERSION` (same pattern as `node`/`pnpm` above), and
downloaded to a file before executing it rather than the common
`curl ... | sh` one-liner, which silently no-ops instead of failing the
build if `curl` can't reach the network (Docker's default `RUN` shell has
no `pipefail`, so a failed `curl` piped into `sh` still leaves `sh`
exiting 0 on its empty stdin) — and copied into the runtime stage rather
than re-running the installer there:

- Per-user installs, no root needed: mise installs everything under
  `$HOME/.local/share/mise`, matching the container's non-root `node` user
  — no `sudo`/`apt` story to build.
- One tool, many languages: node, go, python, rust, ruby, and dozens more
  via mise's plugin backends, instead of bolting on a separate
  nvm/pyenv/goenv/rbenv per language.
- Respects whatever the target repo already declares: `.tool-versions`,
  `.nvmrc`, `.python-version`, or its own `mise.toml` are picked up
  automatically by `mise install`/`mise use` — a session doesn't need to be
  told which versions to fetch, just to run the tool.
- Shim-based activation instead of `mise activate` (which needs an
  interactive shell to `eval` into `.bashrc`): the shims directory
  (`~/.local/share/mise/shims`) is put first on `$PATH` directly in the
  image, so `node`/`go`/`python`/etc. resolve correctly for a session's
  non-interactive, per-command Bash tool invocations with no shell
  initialization step required.
- `apps/server/src/agents/claude.ts`'s native-sandbox `filesystem.allowWrite`
  (ADR-0010) gets mise's default data/state/cache/config dirs
  (`MISE_WRITABLE_PATHS`), the same way it already carries Claude's own
  scratch dirs (`CLAUDE_SCRATCH_WRITABLE_PATHS`) — all of it lives under
  `$HOME`, outside the worktree the sandbox otherwise confines writes to,
  so without this grant every `mise install`/`mise use` would fail
  "read-only file system".

dilna's own baked `node:24`/`pnpm` (via `corepack`, in the Dockerfile) are
unchanged and still what builds dilna itself — mise is additive, for the
repos sessions are pointed at, not a replacement for dilna's own build
tooling. The root `mise.toml` (pinning `node`/`pnpm` for contributors
running dilna on bare host) is a separate, pre-existing use of the same
tool for a different purpose and isn't affected by this change.

### Runtime toolbelt

The runtime image's `apt-get install` also picks up a small set of
generically-useful CLI tools alongside mise, on the same reasoning as the
existing `git`/`openssh-client`/etc. entries — cheap, broadly applicable to
whatever a session's Bash tool ends up needing, not language-specific:

- `curl`: a session's own general-purpose fetch (hitting its dev server,
  GitHub/GitLab APIs, one-off scripts), and what mise's asdf/vfox-compatible
  plugins (the long tail of tools beyond its Rust-native core backends)
  shell out to for their own downloads.
- `unzip`, `xz-utils`: asdf-style plugin install scripts commonly unpack a
  `.zip` or `.tar.xz` release asset themselves via these; mise's own core
  backends extract archives internally and don't need them.
- `jq`: the standard way a Bash-tool command parses JSON (`package.json`,
  API responses, lockfiles) without reaching for a scripting language.
- `procps`, `lsof`: let a session find and kill whatever's holding a port or
  PID after it backgrounds a dev server/watcher, instead of getting stuck on
  "address already in use".

Deliberately left out for now, as a bigger tradeoff than the above rather
than an oversight:

- **`build-essential` + headers** (`libssl-dev`, `zlib1g-dev`, etc.): the
  actual fix for the Python-compile gap noted below, but a meaningfully
  bigger image/attack-surface addition than the single-binary tools above.
  Left for a follow-up specifically requested, rather than bundled
  speculatively into this change.
- **`gh` (GitHub CLI)**: useful for PR/issue workflows, but has no
  credential story yet — ADR-0005's host-passthrough only covers git SSH and
  the Claude token, not a `gh auth` flow. Adding it without auth wired up
  would just be a binary that fails on first use. Resolved in ADR-0013 —
  `gh` reads a `GH_TOKEN` env var directly, needing no login flow at all.

### Config trust

Verified live against a real deployed image (a `mise use node@22` in a
scratch dir did a real download, checksum, and extract, then resolved via
the shim — the feature works end to end) — but that same verification
surfaced a real gap: mise refuses to parse any `mise.toml` with an `[env]`
block, a templated `[tasks]` entry, or tool options until it's explicitly
trusted (its own defense against a cloned repo smuggling arbitrary
env/code into a config file nobody reviewed — plain `[tools]` version
pins and template-free `[tasks]` load fine either way). Hitting an
untrusted one doesn't just make `mise` itself fail — it breaks *every*
shimmed command in that directory tree outright, since each shim's own
resolution logic re-parses the config on every invocation. Nothing in
dilna's headless flow ever runs `mise trust` interactively, so the first
session whose worktree contains such a config would silently lose every
shimmed tool, not just mise-specific ones — directly contradicting
ADR-0003's "sessions act autonomously" model with a second, independent
trust gate nobody asked for.

Fixed in `startClaude` by setting `MISE_TRUSTED_CONFIG_PATHS` (appended to
any existing value) to `opts.worktreePath` via the query's `options.env` —
confirmed live that this is a prefix match (a `mise.toml` nested anywhere
under the worktree, not just at its root, is covered) and doesn't require
also trusting `workspaceRoot` or any path outside the worktree. Since
`options.env` replaces the subprocess environment entirely rather than
merging with `process.env` (documented on the SDK's own `env` field), the
fix spreads `process.env` itself before adding the override — every other
env var a session's subprocess already relied on stays exactly as it was
before this change.

## Why not the alternatives

- **asdf**: same per-language-plugin model mise was built to replace, but
  shell-function based (slower per invocation) and its activation model
  assumes an interactive shell sourcing it, same friction as mise's own
  `activate` mode above.
- **nvm/pyenv/goenv/rbenv, one per language**: N tools to install, update,
  and reason about instead of one; still hits the same "needs interactive
  shell sourcing" problem for at least nvm.
- **Bake specific language versions into the runtime image (e.g. add
  `python3`, `golang` via `apt-get`)**: fixes nothing for a version other
  than whatever Debian bookworm ships, and doesn't scale — every language a
  session might ever need would have to be anticipated and baked in ahead
  of time, ballooning the image for languages most sessions never touch.
- **Give the container a real package manager and root (e.g. run as root,
  or grant passwordless `sudo`)**: reopens exactly the privilege question
  ADR-0009/0010 already closed the other way — the runtime process must not
  run as root for Claude Code's `bypassPermissions` mode to even start.

## Consequences

- Sessions can now self-serve a toolchain: `mise install` inside a worktree
  picks up whatever version file the cloned repo ships, then linting/testing
  that repo works with its own tools rather than whatever dilna happened to
  bake in.
- Not solved by this change: some mise backends (e.g. the core `python`
  plugin, which builds via `python-build`) compile from source and need a
  toolchain (`build-essential`, headers, `libssl-dev`, etc.) the runtime
  image doesn't currently carry — `python3`/`make`/`g++` are only present in
  the *build* stage, for dilna's own native modules. A session asking to
  install Python today will hit that gap; adding the missing apt packages
  to the runtime stage is a follow-up if/when that's actually needed, not
  done speculatively here.
- No new trust boundary: sessions already run headless with unrestricted
  outbound network access and no per-tool approval (ADR-0003/0010) — mise
  fetching and executing arbitrary release tarballs on a session's behalf is
  the same trust level as everything else the Bash tool can already do, not
  a new category of risk.
- Bare-host dev (the repo root's own `mise.toml`) is untouched; this ADR is
  scoped to the Docker runtime image sessions actually run inside of in
  every non-dev deployment.
