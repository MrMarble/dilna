# Sandbox agent processes to their worktree via bubblewrap

ADR-0003 justified auto-approving every tool call ("no per-tool approval, the stop button is the manual override") on the assumption that "the agent runs in an isolated docker container with no host access, so the blast radius is the worktree only." That isolation was never actually built — `startOpencode`/`startClaude` just called `child_process.spawn()` on the host, with `cwd` set to the worktree as a convention, not a boundary. An agent could (and, during dogfooding, did) write outside its assigned worktree — in the observed incident, into dilna's own live checkout — via an absolute path or a `bash` tool call.

## Decision

`apps/server/src/agents/sandbox.ts` wraps every spawned agent process (`opencode serve`, and Claude Agent SDK's subprocess via its `spawnClaudeCodeProcess` hook) with [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`):

- The whole filesystem is bind-mounted **read-only** (`--ro-bind / /`).
- The session's worktree is the one path bind-mounted **read-write**.
- A private, empty `/tmp` isolates scratch-file usage from the host's real one — except when the worktree (or another writable path) is itself under `/tmp`, in which case the replacement is skipped; tmpfs-replacing `/tmp` while only rw-binding one subdirectory under it hides that subdirectory's real siblings (a bare repo's `objects`/`refs` alongside the one worktree we bind), which broke git's own worktree resolution during testing ("not a git repository: (null)").
- The network namespace is **not** unshared — agents need outbound access for LLM provider APIs and git remotes. This sandboxes filesystem writes only, not network egress or process visibility.
- A handful of additional writable paths are granted per backend: each backend's own cache/log/data directories (opencode's `~/.local/share/opencode` + `~/.config/opencode`; Claude's `~/.cache/claude` + `~/.cache/claude-cli-nodejs` — deliberately narrower than all of `~/.claude`, which holds global settings, skills, and credentials the sandboxed agent has no business writing to), and the git worktree's shared common dir (resolved by reading the worktree's `.git` pointer file and its `commondir`, rather than reconstructing git's internal layout) — `git add` needs to write new blob objects to the origin repo's shared object store, not just the per-worktree metadata (HEAD, index, refs). Granting that is safe within dilna's model: it's the same Repo's own plumbing, not another session's or repo's data.

## Why bubblewrap and not a container per session

ADR-0003's own language said "docker container." We used bwrap instead:

- **Scoped to the actual requirement.** The reported problem and the fix both concern filesystem writes only ("agents should only have access to the worktree folder") — not process or network isolation. bwrap does exactly that, with no new daemon dependency.
- **No Docker-in-Docker problem.** A per-session container would need the dilna server itself to reach a Docker daemon (socket-mounted or sibling), which is a much bigger dependency shift — especially once dilna itself runs inside a container (ADR-0009). bwrap runs as a direct subprocess wrapper regardless of how dilna itself is deployed.
- **Lighter weight.** No image pulls, no container lifecycle to manage per session — just a wrapped `spawn()` call, matching the existing one-process-per-session model (ADR-0003) instead of replacing it.

## Consequences

- `bwrap` must be present on the host (or in dilna's own container image, for the Docker deployment path — not yet added to `Dockerfile`; tracked as follow-up, not blocking since local/dev usage is the immediate concern).
- Verified end-to-end: a sandboxed agent's attempt to write outside its worktree fails with a read-only-filesystem error and creates nothing on the host; normal operation inside the worktree (file writes, `git add`/`commit`/`log`) works unchanged.
- This doesn't sandbox process visibility (PID namespace is shared) or network access (intentionally) — an agent could still, in principle, signal unrelated host processes it has permission for, or exfiltrate data over the network. Only filesystem writes are confined. Full defense-in-depth (seccomp, PID/network namespaces) is a larger follow-up, not required by the reported incident.
