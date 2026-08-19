# Per-Repo agent memory: a bounded SQLite row, agent-direct-write, no approval gate yet

## Context

[Issue #59](https://github.com/MrMarble/dilna/issues/59) identified a gap: ADR-0010 deliberately isolates each Session's Worktree, so an agent that discovers something durable about a **Repo** — "tests need `FOO_ENV` set", "this suite is flaky on CI", "don't hand-edit the generated file, it's overwritten by build" — has no way to pass that on to the next Session on the same Repo. Every Session rediscovers the same friction from scratch. Inspired by Hermes Agent's `MEMORY.md`-equivalent, the issue proposed a small, bounded, agent-curated memory injected into every new Session's context, scoped per-Repo (not per-Session/Worktree — Worktrees are throwaway per CONTEXT.md; the Repo is the durable unit).

The issue left four open questions, resolved via [issue comment](https://github.com/MrMarble/dilna/issues/59#issuecomment-5273009395) from @MrMarble:

## Decision

- **Storage**: a `repo_memory` SQLite table (ADR-0004's existing store), one row per Repo — `repoId` (PK), `content`, `updatedAt` — not a file in the bare repo checkout. The DB is already dilna's source of truth for everything else session-related, and the memory has to be read and injected into context on every Session start regardless of backend, which a DB row serves more directly than a file dilna would have to locate and parse per Repo.
- **Write path**: `apps/server/src/repos/memory.ts` exports `getRepoMemory`/`setRepoMemory` as the one function pair every write goes through, matching the comment's "we should have a function to store/restore." `setRepoMemory` does a **wholesale replace**, not a merge — the agent reads current content from its own system prompt, edits it, and sends the full result back. `apps/server/src/agents/claude.ts` registers `setRepoMemory` behind an in-process SDK tool (`update_repo_memory`, via `createSdkMcpServer`/`tool`) that the agent calls **directly** — unlike `session_status` (ADR-0016 §1), there's no ordering or broadcast contract a mediating `SessionManager` call would protect; it's a single-row upsert with no subscriber-facing effect.
- **No approval gate**: dilna has no notification/prompt system yet (per the comment), so writes land immediately, matching ADR-0003's "bypassPermissions, the agent runs autonomously" model already governing every other tool call. `setRepoMemory` is the single choke point every write passes through, so a gate can be inserted there later without touching the tool wiring or `claude.ts`.
- **Size bound**: hard cap at `REPO_MEMORY_MAX_CHARS` (2,200 characters, matching the cap the issue referenced from Hermes and the comment's "seems reasonable"). Enforced in `setRepoMemory`, not the DB column or the tool's input schema, so it's one answer regardless of caller. An over-limit call is **rejected with an error** telling the agent to trim and resend — not silently truncated — since silent truncation could cut a fact off mid-sentence with no signal to the agent that it happened.
- **No eviction/summarization**: out of scope for this change. The cap forces the agent itself to curate (drop stale entries to make room for new ones) rather than dilna implementing automatic staleness tracking — revisit if real usage shows agents failing to self-curate.

## Why not the alternatives

- **A file in the bare repo checkout**: would need dilna to read/parse/write a file path per Repo on every Session start and every tool call, and doesn't fit the sandbox's read/write confinement model (ADR-0010) any more naturally than a DB row does — the DB was already the simpler, already-present mechanism.
- **`SessionManager`-mediated writes** (matching `session_status`): considered for consistency with ADR-0016's "one emitter" pattern, but that pattern exists specifically to protect turn-lifecycle ordering guarantees subscribers depend on. Memory writes have no subscriber-facing ordering to protect — mediating them through `SessionManager` would add a hop with no corresponding benefit.
- **Gating writes behind approval**: deferred, not rejected — dilna has no notification/prompt system to gate behind yet, and building one is a separate, larger effort. `setRepoMemory` as a single choke point keeps this reversible.

## Consequences

- New table `repo_memory`; `RepoManager.delete` now also deletes the Repo's memory row, since nothing else would ever clean it up.
- `apps/server/src/agents/claude.ts` gains a `repoId` field on `ClaudeStartOptions` (`SessionManager.ensureStarted` passes `session.repoId`) and an in-process `mcpServers` entry — dilna's first use of the SDK's custom-tool mechanism, alongside `zod` as a new direct dependency (already present transitively as the SDK's own peer dependency).
- Memory is Claude-backend-only for now, same scope as the rest of `claude.ts`'s Claude-specific wiring (ADR-0011 dropped opencode as a second backend).
- A future notification/prompt system (referenced in the issue discussion) can gate `setRepoMemory` without touching `claude.ts`'s tool registration.
