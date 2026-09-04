# Orchestrator spawn lineage: `sessions.spawnedBy` + a `spawnedByMe` list filter

## Context

A review of OpenClaw (a large, independent coding-agent harness) for further
improvement ideas, done after ADR-0023/0024 shipped, flagged its detached
task runtime: every spawned unit of work becomes a `TaskRecord` with a
lifecycle (queued → running → completed/failed) and a link back to what
spawned it, plus a recovery hook that reconciles a still-"running" task
after a restart before writing it off as lost. On the surface this looked
like it addressed two gaps in dilna's orchestrator (ADR-0021):
`dilna_create_session` is fire-and-forget with no lifecycle record beyond
re-listing Sessions, and ADR-0020's Consequences accept "no attempt to
reconcile a mid-turn crash" as a known gap.

Investigating dilna's actual mechanics narrowed this to one real gap, not
two:

- **Crash-recovery reconciliation doesn't need new machinery.** A
  `dilna_create_session` call always creates a real Session (ADR-0021's own
  reasoning: "an orchestrator session needs a different Agent tool set, not
  a different lifecycle... resumability, SSE, and idle-kill are free").
  That Session is subject to the exact same crash-recovery path (ADR-0014's
  turn durability, `resetAllToIdle`) as any other Session — its `status`
  already reflects reality correctly after a server restart, independent of
  whether the orchestrator that spawned it also survived. There is no
  OpenClaw-shaped "task stuck marked running" state to reconcile.
- **Lineage is the real gap.** Orchestrator Sessions are not a singleton —
  the sidebar's "Orchestrator" entry lists multiple, sorted by
  `lastActiveAt`, the same as ordinary Sessions (`App.tsx`'s
  `orchestratorSessions`). Nothing links a Session `dilna_create_session`
  spawned back to the orchestrator Session that spawned it. Today, the only
  way an orchestrator can answer "what did I create" is recalling ids from
  its own turn history — which breaks the moment that history isn't in
  context anymore: a fresh orchestrator conversation, or a user resuming an
  old one and asking "how did those sessions turn out" long after the
  `dilna_create_session` results scrolled out of what's salient. There is no
  way today to ask dilna directly, even though `dilna_list_sessions` already
  supports a `repoId` filter for the analogous "narrow the list" need.

## Decision

**New nullable `sessions.spawnedBy` column** (text, no FK — same
dangling-id tolerance as `usage_events`/`session_archive`; an orchestrator
Session being deleted, itself archived per ADR-0024, shouldn't need to
touch every Session it ever spawned). Null for every Session created
directly via the UI (`POST /api/sessions`) or as an orchestrator Session
itself (`createOrchestrator`); set to the spawning orchestrator's own
Session id only when created via `dilna_create_session`.

**`SessionManager.create` gains an optional trailing `spawnedBy?: string`
param.** `buildOrchestratorDeps`'s `createChildSession` closure passes its
own session id (available where `buildOrchestratorDeps` is already
constructed, inside `startAgent`); every other call site is unaffected
(the param defaults to `null`).

**`dilna_list_sessions` gains an optional `spawnedByMe: boolean` param**,
alongside its existing `repoId` filter — `true` additionally filters to
Sessions whose `spawnedBy` equals the *calling* orchestrator's own Session
id. That id is closed over server-side when `buildOrchestratorDeps` is
constructed for this specific orchestrator Session, never passed by the
model as a tool argument — so one orchestrator can't query or spoof another
orchestrator's lineage, matching ADR-0021's "curated tools, not a generic
escape hatch" precedent. `ORCHESTRATOR_SYSTEM_PROMPT` is updated to mention
it for "what did I create" follow-ups.

## Why not the alternatives

- **A separate `orchestrator_tasks` table with its own lifecycle** (the
  literal shape of OpenClaw's `TaskRecord`): rejected — a spawned Session's
  `status` already is its lifecycle; a parallel state machine would just
  drift from the Session's own real status over time, the same reasoning
  ADR-0021 already used to reject a separate table for orchestrator Sessions
  themselves.
- **A generic `parentSessionId`** implying a broader session-hierarchy
  concept: rejected — dilna has exactly one producer of child Sessions
  today (the orchestrator). Naming the column for what it concretely is
  keeps it honest; revisit the name if a second producer of lineage ever
  shows up.
- **A crash-recovery reconciliation hook**: rejected outright — no new
  failure mode was found that ADR-0014's existing per-Session mechanisms
  don't already cover.
- **Exposing `spawnedBy` on `dilna_get_session`'s per-Session payload
  too**: left out — the list filter alone satisfies the stated need
  ("what did I create"); add a single-Session field later only if real
  usage shows it's needed beyond the list view.

## Consequences

- New nullable `sessions.spawnedBy` column (migration); every existing row
  starts null.
- `SessionManager.create`'s signature grows one optional trailing param;
  every existing call site stays source-compatible.
- `dilna_list_sessions`'s schema and description grow one optional boolean
  field.
- Does not address one orchestrator asking about a Session a *different*
  orchestrator instance spawned — matches dilna's existing model (each
  orchestrator Session is its own independent conversation), not a new
  limitation introduced here.
