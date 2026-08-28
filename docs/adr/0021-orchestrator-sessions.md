# Orchestrator sessions: a global meta-chat driving dilna's own session API

## Context

[Issue #79](https://github.com/MrMarble/dilna/issues/79) proposed an orchestrator: a chat you task with batches of work ("work on issues 79, 80, 81 in repo dilna, one session each") that fans it out into ordinary Sessions via `SessionManager` directly, rather than the user doing that by hand. The issue laid out the precedent (Session creation is already a small clean API; ADR-0018's `update_repo_memory` already shows an Agent calling dilna's own internals via an in-process SDK tool) and left six open questions for the repo owner to settle before implementation.

Resolved via conversation with @MrMarble:

1. **Scope**: global, not repo-scoped (issue's Option B, not its leaning A) — one orchestrator, not one per repo, able to target any repo per spawn.
2. **Tool surface for introspection** ("ask it about usage and anything in the database"): curated, purpose-built read tools, matching ADR-0018's precedent — not a generic SQL escape hatch.
3. **Guardrails**: `dilna_create_session` fires immediately (matches ADR-0003's `bypassPermissions` model already governing every other tool call), backstopped by a hard per-turn cap rather than a confirm-before-spawn step.
4. **Feedback loop**: fire-and-forget. The orchestrator gets on-demand polling tools; no background watcher, no unprompted status pushes into its own chat.

This ADR covers the two open questions the issue left as implementation-level (Q2 "does it need a worktree", Q6 "reuse `sessions` vs a new table") now that scope is known to be global.

## Decision

**Reuse the `sessions` table, discriminated by a new `kind` column** (`"session" | "orchestrator"`, default `"session"`), rather than a parallel table. An orchestrator session is a Session in every structural sense dilna already has machinery for (resumable chat, SSE stream, idle-kill, DB-backed history) — the only thing that differs is which tools its Agent is wired with.

**Give every orchestrator session a real (throwaway) Worktree, like any Session** — but bound to one reserved, hidden **meta-repo** (`apps/server/src/repos/manager.ts` gains `ensureOrchestratorRepo()`: a local `git init --bare` repo with one empty root commit, created lazily, reserved slug, filtered out of `GET /api/repos` and the sidebar's repo list) instead of a real cloned repo. This:

- Reuses `SessionManager.create`/`delete`/worktree lifecycle verbatim — no nullable-column ripple through `Session`/`SessionView`, `ChatShell`, `Sidebar`, diff/changed-files/commits/transcript code, all of which currently assume a real `repoId`/`worktreePath`.
- Gives the orchestrator's `Agent` construction a valid `cwd` for free, even though the orchestrator's tool set (below) never touches it — no filesystem/bash tools are registered for `kind: "orchestrator"`, so the meta-repo's actual contents are irrelevant.
- Keeps "global" honest: the meta-repo is not a target repo. Which repo a spawned child Session lands in is chosen per `dilna_create_session` call, independent of the orchestrator's own (irrelevant) worktree.

**Orchestrator tool surface** — new `apps/server/src/agents/orchestratorTools.ts`, registered only when `session.kind === "orchestrator"` (`agents/pi.ts` gains `startOrchestrator`, alongside `startPi`, with no coding tools/sandbox/confinement hook):

- `dilna_list_repos()` — id/slug/defaultBranch for every real repo (meta-repo excluded).
- `dilna_list_sessions({ repoId? })` — id/title/repoId/status/usage/createdAt/lastActiveAt for ordinary Sessions (orchestrator Sessions themselves excluded from results).
- `dilna_get_session({ sessionId })` — single-session detail: the above fields plus a short summary of its latest activity (not a full transcript dump, to keep context bounded).
- `dilna_usage_totals()` — token usage aggregated across sessions/repos, for "how much have we spent on X" questions.
- `dilna_create_session({ repoId, prompt })` — `SessionManager.create(repoId, "pi")` + `beginTurn`/`runTurn(prompt)`, fired the same fire-and-forget way the web UI's own chat send already works (202-shaped: kick off, don't block on completion). Capped at a fixed number of calls per turn (blast-radius guardrail per decision 3 above) — the turn's tool-call loop errors past the cap rather than dilna silently dropping calls.

**UI**: a new top-level entry point ("Orchestrator", alongside — not nested under — the repo list, since it's global rather than per-repo), opening the same `ChatShell` with `kind: "orchestrator"` suppressing the repo-bound panels (Changed files, Commits, diff) that don't apply.

## Why not the alternatives

- **Nullable `repoId`/`worktreePath`/`branchName` on `sessions`** (the literal reading of "global = not bound to a repo"): rejected — every consumer of `Session`/`SessionView` on both server and web currently assumes these are non-null, so nullability would ripple into diff computation, the transcript export route, `ChatHeader`/`ContextPanel`, and `Sidebar`'s `repoSlugById` lookups, for a distinction (has vs. lacks a worktree) the meta-repo already expresses without touching any of that.
- **A separate table/concept for orchestrator sessions**: rejected on the same grounds as ADR-0002/0007/ADR-0011's "adapter file + dispatch branch, not a new abstraction layer" — an orchestrator session needs a different Agent tool set, not a different lifecycle. Reusing `sessions` means resumability, SSE, and idle-kill are free.
- **Generic read-only SQL tool** for introspection: more flexible on paper, but no precedent in the codebase (every existing agent-facing tool is purpose-built — ADR-0018), and hands the LLM the raw schema instead of a stable, intention-revealing surface.
- **Confirm-before-spawn**: adds a turn round-trip for every batch and diverges from ADR-0003's autonomous-tool-call model everyone else follows; a per-turn cap gives the same blast-radius protection without it.
- **Active tracking / unprompted status pushes**: would need a background watcher plus a way to inject events into an otherwise-idle orchestrator turn — real complexity for a feature with no proven demand yet. On-demand polling tools cover "check on what I started" today; revisit if usage shows it's needed (same "ship small, revisit on real usage" precedent as ADR-0018's no-eviction call).

## Consequences

- New `sessions.kind` column (migration), default `"session"` — every existing row is unaffected.
- New reserved, hidden Repo row (the orchestrator meta-repo) that `GET /api/repos` and repo-pull/sync-status code must not surface or attempt to treat as a real target.
- `apps/server/src/agents/pi.ts` gains a second entry point (`startOrchestrator`) alongside `startPi`; `SessionManager` dispatches on `session.kind` wherever it currently calls into `pi.ts` unconditionally.
- New per-turn cap constant for `dilna_create_session` — a fixed number, not user-configurable, revisit if real usage needs it higher/lower or per-orchestrator.
- Orchestrator sessions are pi-backend-only from day one (no `agentType` branching needed — `CREATABLE_AGENT_TYPES` is already `["pi"]` only).
