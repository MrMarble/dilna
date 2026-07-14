# Agent lifecycle: one `opencode serve` per worktree, idle-killed at 5 minutes, runs with --auto

## Context

Each dilna **Session** is bound 1:1 to a **Worktree** (per CONTEXT.md), and the worktree's path must be the agent's working directory.

The opencode SDK exposes a per-session `directory` query param (`SessionCreateData.query.directory`), so in principle one shared `opencode serve` could host many sessions across different worktrees. We deliberately do not use that. Instead each Session gets its own `opencode serve` child process with the worktree's path as the `project` positional; the per-session `directory` API is left unused.

The user wants agents to run only while actively in use: spawn on first interaction, kill when idle, resume the same opencode session id when the user returns. Agents keep working in the background after the browser tab closes — they only die when they're genuinely waiting for human input past an idle timeout.

## Decision

**Process model:** one `opencode serve` child process per active session, started with the worktree's path as the spawn's `cwd` (opencode's global `[project]` positional isn't valid on the `serve` subcommand) and a dynamically-allocated port. dilna's SessionManager owns spawn/supervise/kill for these processes.

**Lifecycle:**
- Sessions start **idle** — no agent process resident.
- User sends the first message (or resumes a parked session) → SessionManager spawns `opencode serve` with the worktree as cwd, then either `client.session.create()` (fresh) or `client.session.chat(existingOpencodeSessionId, ...)` (resume). Opencode sessions persist in opencode's own db across server restarts, so resume is cheap.
- After the agent finishes responding and no new user message has arrived, a **5-minute idle timer** starts. Timer resets on any new user message. When it fires, SessionManager kills the process.
- If the agent is mid-work (streaming tokens, running tool calls, executing subagents) it is **not idle** and is never killed, regardless of browser connection state. The browser tab closing does not stop a working agent.
- A **stop button** in the UI is the hard kill-switch — instant terminate the spawn, even mid-work.

**Permissions:** pass `auto-approve` via the `OPENCODE_CONFIG_CONTENT='{"permission":"allow"}'` env var (the `--auto` flag is only valid on the default TUI command, not the `serve` subcommand — and the env var persists across opencode versions more reliably than per-subcommand flag handling). The agent never blocks waiting for tool-call approval. Solo-tenant + the agent runs in an isolated docker container with no host access, so the blast radius is the worktree only. The stop button is the manual override.

## Why one server per worktree (and not a shared server)

- **Process isolation:** a crashed `opencode serve` takes down one session, not all of them. A single shared server kills all your work on one bad bug.
- **Lifecycle simplicity:** the idle-kill / spawn cycle maps to one process for one Session. A shared server would need a "stop only when zero sessions are active" policy and a separate lease/refcount layer.
- **Cost is acceptable:** single-tenant with one or two concurrent sessions doesn't feel the N-processes memory cost; opencode's per-session `directory` API would let us avoid it (shared server with N sessions), but the isolation benefit matters more.
- Worth noting for the future: if dilna ever moves to many concurrent sessions (multi-tenant), revisiting the shared-server-with-per-session-directory model becomes worthwhile.

## Consequences

- N concurrent active sessions = N resident node processes. Fine for single-tenant personal use; would need session multiplexing or container-per-session later for multi-tenant.
- dilna caches message history in its own SQLite (per ADR-0004) so the chat UI keeps working after the agent process dies — the user can read prior messages and the resume-on-next-send is invisible.
- Server restart kills any resident agents. Their sessions are parked (opencode db intact), resume on next user message. ~~No work-in-progress is preserved mid-tool-call — if the agent was mid-write when the server died, that work is lost. Acceptable for MVP.~~ Superseded by ADR-0014: interrupted turns are backfilled from the agent's own transcript on boot, and the in-flight turn is replayed to subscribers that connect mid-turn.
- Permission UX is "trust + manual stop button." A future permissions-relay-to-UI flow is a separate feature, not a refactor of this lifecycle.
- Port allocation: SessionManager must pick a free port per spawn. Use 0 to let the OS assign, read back the assigned port, pass to the SDK client.