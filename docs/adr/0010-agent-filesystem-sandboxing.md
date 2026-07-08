# Sandbox agent processes to their worktree via sandlock

> **Note (ADR-0011)**: opencode was dropped as a backend after this ADR was
> written. References below to `startOpencode`, opencode's writable paths,
> and its `--net-allow-bind` port grant describe a mechanism that no longer
> exists in the code; the write-confinement approach itself (Landlock +
> seccomp via sandlock) is unchanged and now applies to the sole surviving
> Claude backend.
>
> **Read confinement (`--fs-deny` sibling denial, described below) was
> reverted**: it makes the Claude Agent SDK's Bun-compiled CLI exit
> immediately with no output, for *any* `--fs-deny` rule regardless of which
> path is denied — confirmed by bisecting down to a single irrelevant
> `--fs-deny` path breaking a bare `claude --version`, while the same rule
> set works fine for non-Bun commands (`echo`). This wasn't caught by this
> ADR's original end-to-end verification because that testing never exercised
> a `DILNA_DATA_DIR` inside dilna's own checkout with more than one
> repo/session on disk — the only conditions under which
> `denyPathsOutsideSession` actually emits a `--fs-deny` flag. See "Read
> confinement via dynamic sibling denial" and Consequences below for what
> this means going forward.

ADR-0003 justified auto-approving every tool call ("no per-tool approval, the stop button is the manual override") on the assumption that "the agent runs in an isolated docker container with no host access, so the blast radius is the worktree only." That isolation was never actually built — `startOpencode`/`startClaude` just called `child_process.spawn()` on the host, with `cwd` set to the worktree as a convention, not a boundary. An agent could (and, during dogfooding, did) write outside its assigned worktree — in the observed incident, into dilna's own live checkout — via an absolute path or a `bash` tool call. A second dogfooding session then showed the same gap on the read side: asked about its own working directory, an agent walked up its own worktree's ancestor directories, read dilna's own `CLAUDE.md`, and used it to reason about a project it had no business seeing at all.

## Decision

`apps/server/src/agents/sandbox.ts` wraps every spawned agent process (`opencode serve`, and Claude Agent SDK's subprocess via its `spawnClaudeCodeProcess` hook) with [sandlock](https://github.com/multikernel/sandlock), a Landlock + seccomp-bpf sandboxing tool:

- The session's worktree is the one path granted write access (`-w`).
- A handful of additional writable paths are granted for Claude's own cache/log/transcript directories: `~/.cache/claude`, `~/.cache/claude-cli-nodejs`, `~/.claude/session-env`, `~/.claude/projects` (the CLI's own session transcript storage — `getSessionMessages`/`getSessionInfo` read from here after every turn; omitting it silently breaks persisted history and title auto-sync, since the sandboxed process can never write its own transcript), and `/tmp/claude-<uid>` — all per-session scratch dirs the CLI creates itself, deliberately narrower than all of `~/.claude`, which also holds global settings, skills, and credentials the sandboxed agent has no business writing to. Also granted: `/dev/null` (needed by git during `add`/`commit`; Landlock doesn't expose device nodes through the broad `-r /` read grant the way a mount-namespace tool would), and the git worktree's shared common dir (resolved by reading the worktree's `.git` pointer file and its `commondir`, rather than reconstructing git's internal layout) — `git add` needs to write new blob objects to the origin repo's shared object store, not just the per-worktree metadata (HEAD, index, refs). Granting that is safe within dilna's model: it's the same Repo's own plumbing, not another session's or repo's data.
- The base filesystem grant is broad read (`-r /`) — the agent binary itself, git, bash, and their shared libraries all need to read arbitrary system paths to function, and enumerating exactly what they need would be its own maintenance burden. Narrowing this to "this worktree only" was attempted and reverted (see below); today read access is broad and unconfined, matching the original bwrap-era posture.
- Networking is deny-by-default under sandlock (both outbound connect and inbound bind), unlike filesystem access. Outbound is opened unconditionally (`--net-allow '*'` + `--net-allow 'udp://*'`) since agents need it for LLM provider APIs, git remotes, and whatever else they're asked to fetch — none of which is enumerable in advance. Inbound bind is granted per-port only where needed: opencode's `serve` HTTP server (`allowBindPorts`), not Claude's SDK subprocess, which communicates over stdio.

### Read confinement via dynamic sibling denial (tried, then reverted)

The second incident above called for narrowing *read*, not just write, to the worktree. The natural-looking fix — deny read on dilna's whole checkout, then re-allow the one worktree nested inside `data/worktrees/<repo>/<session>` — does not work with sandlock: verified empirically that `--fs-deny` on a parent path always wins over a more specific `-r`/`-w` nested inside it, regardless of flag order. There is no "deny this, except that nested path" primitive.

Instead, `denyPathsOutsideSession` (formerly in `sandbox.ts`, since removed) computed deny rules for true *siblings* of what a session needs, never an ancestor of it:

- Siblings of the current repo under `data/worktrees/` (other repos' worktrees entirely).
- Siblings of the current session under `data/worktrees/<repo>/` (other sessions of the same repo).
- Siblings of the current repo's bare clone under `data/repos/` (other repos' shared git object stores).
- When `DILNA_DATA_DIR` resolves inside dilna's own checkout (as it does by default in local dev, via `mise.toml`'s `DILNA_DATA_DIR=./data`) — every sibling of the data dir at the checkout root: `apps/`, `packages/`, `docs/`, `.git/`, config files, etc.

This shipped and was verified against a narrow test (single repo, single session, `DILNA_DATA_DIR` outside the checkout — see this ADR's original Consequences) where `denyPathsOutsideSession` happens to return an empty list, so no `--fs-deny` flag was ever actually passed during that verification. Real usage (`DILNA_DATA_DIR` defaulting to `./data` inside the checkout, per `mise.toml`) always produces at least one `--fs-deny` flag once dilna's other top-level directories exist — and that broke every Claude session outright: the Claude Agent SDK's CLI (`@anthropic-ai/claude-agent-sdk-linux-x64`, a Bun-compiled binary) exits immediately with code 1 and zero stdout/stderr output whenever *any* `--fs-deny` rule is present, independent of which path is denied. Confirmed by bisection: `sandlock run -r / -w <worktree> --fs-deny /some/irrelevant/path -- claude --version` fails the same way as the full rule set; the same sandbox invocation with `echo` instead of `claude` succeeds. No matching upstream issue found in sandlock's or Bun's issue trackers as of this writing — likely a novel interaction between Bun's runtime and Landlock's ruleset-change behavior when a deny rule is present, not investigated further.

`denyPathsOutsideSession`, `denySiblings`, and `findWorkspaceRoot` were removed from `sandbox.ts` and `--fs-deny` is no longer emitted. **Read confinement is currently not implemented** — the second dogfooding incident (an agent reading dilna's own `CLAUDE.md`) is an open, unfixed gap again. Write confinement (the more severe of the two incidents, and unaffected by this bug) still holds.

## Why sandlock and not bubblewrap

The first implementation (see prior revisions of this ADR) used [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`), a mount-namespace-based sandbox. It worked cleanly on a bare host, but doesn't fit dilna's Docker/Kubernetes deployment target (ADR-0009): creating a new mount namespace and calling `pivot_root` needs `CAP_SYS_ADMIN` plus disabling both seccomp *and* AppArmor entirely inside the container — a broad, container-escape-adjacent privilege grant, and a poor fit for running unprivileged in Kubernetes.

sandlock uses Landlock (in-kernel, per-process filesystem access control) and seccomp-bpf with user notification instead of mount namespaces, so it needs no privileged mount operations at all. The only elevated permission it requires is a single narrow capability, `SYS_PTRACE`, used for `pidfd_getfd` to retrieve the seccomp notification fd from the process it supervises — a much smaller ask than bwrap's requirements, and one that maps directly onto a Kubernetes `securityContext.capabilities.add: [SYS_PTRACE]` with no other pod-security relaxation. This was the deciding factor given the deployment target: "no special container config to run it" (no custom seccomp/AppArmor profile, no `--privileged`, no `CAP_SYS_ADMIN`).

Both bwrap and sandlock were still chosen over a container-per-session: the reported problem and the fix concern filesystem writes only, not process or network isolation; a per-session container would need the dilna server itself to reach a Docker daemon (socket-mounted or sibling), a much bigger dependency shift — especially once dilna itself runs inside a container. Both tools instead run as a direct subprocess wrapper regardless of how dilna itself is deployed, matching the existing one-process-per-session model (ADR-0003) rather than replacing it.

## sandlock-specific quirks discovered during migration

- **Network is deny-by-default in both directions.** bwrap simply shared the host's network namespace, so this needed no thought there. sandlock denies outbound connect and inbound bind unless explicitly allowed, which broke both LLM provider API calls (fixed by unconditional `--net-allow`) and opencode's own HTTP server (fixed by `--net-allow-bind <port>`).
- **`/dev/null` needs an explicit write grant.** git redirects through it during `add`/`commit`; Landlock's filesystem mediation doesn't special-case device nodes the way a bind-mount-based tool's broad read grant does.
- **No mount-namespace-related edge cases.** bwrap's `--tmpfs /tmp` replacement broke git worktree resolution when the worktree lived under a real host `/tmp`-based data dir (hiding real siblings of a narrowly-bound subdirectory). sandlock has no tmpfs/mount-namespace mechanism at all, so this class of bug doesn't exist for it.
- **A Bun-compiled child process's own internal spawn calls can fail under nested nesting inside a container with only `SYS_PTRACE`** — observed specifically with opencode (whose CLI is a Bun-compiled binary) spawning a bare single-word command (e.g. `whoami`) as a bash-tool subprocess of an already-sandboxed `opencode serve` process, while a shell-wrapped equivalent (`bash -c '...'`) succeeded. Reproduced only in this two-generations-deep, Bun-specific spawn path inside Docker; a manual `sandlock run -- whoami` and `sandlock run -- bash -c whoami` both succeed identically on the host and directly inside the container. Root cause not fully isolated (leading hypothesis: a Bun runtime syscall used by its spawn implementation interacting poorly with the inherited seccomp filter) and not fixed — tracked as a known opencode-backend limitation, not blocking, since it doesn't affect the Claude Agent SDK backend (a plain Node process tree).

## Why not `@anthropic-ai/sandbox-runtime` or Claude Code's native sandboxed Bash tool

Claude Code has its own built-in sandboxing (`/sandbox`) and a standalone `@anthropic-ai/sandbox-runtime` package that wraps an entire process the same way `spawnSandboxed` does. Both were considered and rejected for dilna's use:

- The built-in sandboxed Bash tool only isolates Bash subprocesses — Read/Edit/Write tool calls are governed by Claude's own permission rules instead of an OS boundary, and dilna runs with `permissionMode: "bypassPermissions"` (per ADR-0003), which skips those rules entirely. It would not have prevented either incident this ADR describes, since neither was necessarily a Bash call.
- `@anthropic-ai/sandbox-runtime` does cover the whole process, but on Linux it's the same bubblewrap dilna migrated away from — including the same unprivileged-container problem. Its own docs point unprivileged-container users at `enableWeakerNestedSandbox`, which "considerably weakens security" and is meant for cases where an outer container already provides the real isolation boundary. Dilna has no such outer boundary (no per-session container — see "Why sandlock and not bubblewrap" below), so adopting it would reintroduce the exact tradeoff the sandlock migration exists to avoid.
- Both are also Claude-specific, so neither would help the opencode backend at all.

## Consequences

- `sandlock` must be present in dilna's own container image (added to `Dockerfile`, pinned release version) and on the host for local/dev usage (not packaged for any distro — fetched as a prebuilt release binary).
- Write confinement is verified end-to-end, including inside a real Docker container: a sandboxed agent's attempt to write outside its worktree fails with a permission error and creates nothing on the host (confirmed via a canary-file test against the actual dilna image); normal operation inside the worktree (file writes, `git add`/`commit`/`log`) works unchanged on the host.
- **Read confinement is not implemented** (see "Read confinement via dynamic sibling denial (tried, then reverted)" above) — an agent can read anywhere the base `-r /` grant allows, including dilna's own source and sibling worktrees/repos. This is a known, currently-accepted gap, not a fixed decision: the second dogfooding incident this ADR opens with is unresolved. Re-attempting it would need either a fix/workaround for the Bun-binary + `--fs-deny` interaction, or a different mechanism entirely (e.g. an explicit `-r` allowlist instead of broad `-r /` plus deny rules — rejected originally as its own maintenance burden, but worth revisiting given `--fs-deny` is now known unusable with this backend).
- This doesn't sandbox process visibility (no PID namespace) or restrict outbound network access (intentionally, per above) — an agent could still, in principle, signal unrelated host processes it has permission for, or exfiltrate data over the network. Full defense-in-depth (PID namespaces, egress allowlisting) is a larger follow-up, not required by the reported incidents.
- The opencode-backend nested-spawn quirk above no longer applies: opencode was dropped as a backend (ADR-0011).
