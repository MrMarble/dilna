# Repo memory: agent-pulled via a tool, not injected into every system prompt

## Context

ADR-0018 gave every Session a per-Repo memory (`getRepoMemory`/`setRepoMemory`,
one `repo_memory` row per Repo) and decided reads happen by injecting the
stored content straight into the system prompt at Session start — reasoning
that "the memory has to be read and injected into context on every Session
start regardless of backend." Writes went through an agent-called tool
(`update_repo_memory`) from the start; reads never did.

Two costs of the injection-only design, raised when reviewing `pi.ts`'s full
env/tool surface after the pi-agent-core migration (ADR-0020):

- `DILNA_AGENT_CONTEXT` — pi.ts's system prompt — has already been trimmed
  twice for size/verbosity (#115, #117). Unconditionally appending a
  `## Repo memory` section (up to `REPO_MEMORY_MAX_CHARS` = 2,200 characters)
  adds to that baseline for every session on every turn, whether or not the
  content ends up relevant to the task at hand.
- It's a start-of-session snapshot only. Sibling Sessions run against
  different Worktrees of the same Repo concurrently (`CONTEXT.md`'s
  **Worktree** entry); one calling `update_repo_memory` mid-session has no
  way to reach an already-running sibling's system prompt, which was fixed
  at construction time.

## Decision

Replace the system-prompt injection with a new `read_repo_memory` tool
(`apps/server/src/agents/pi.ts`, alongside `update_repo_memory`, same
`getRepoMemory`/`setRepoMemory` pair from ADR-0018 — no storage or write-path
change). `startPi` no longer calls `getRepoMemory` up front or appends its
content to the system prompt; `DILNA_AGENT_CONTEXT`'s REPO MEMORY section now
tells the agent to call the tool before exploring an unfamiliar repo, instead
of pointing at a section of its own prompt. `update_repo_memory`'s
description is updated to match: it tells the agent to call `read_repo_memory`
first to get the current content before sending a replacement, rather than
"read the current content from the Repo memory section of your system
prompt."

Matches the write side's existing shape — both reads and writes now go
through explicit tool calls the agent makes on its own judgment, rather than
one being push (injected) and the other pull (tool-called).

## Consequences

- A session that never touches anything memory-relevant no longer pays the
  system-prompt cost for it at all.
- A session can re-check memory mid-task (e.g. before touching something
  that smells like a known gotcha) and see whatever the latest write was,
  not just what existed at Session start.
- Costs an explicit tool call where the agent previously got the content for
  free — relies on `DILNA_AGENT_CONTEXT`'s REPO MEMORY guidance actually
  prompting the call; if agents in practice skip it, revisit (this ADR
  doesn't rule out re-adding a lighter-weight nudge, e.g. a one-line "memory
  exists for this Repo, call read_repo_memory to see it" flag instead of the
  full content, only if that turns out to be necessary).
- Orchestrator Sessions (ADR-0021) are unaffected — they never had
  filesystem/Repo-scoped tools including `update_repo_memory`, and still
  don't get `read_repo_memory` either.
