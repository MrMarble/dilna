# Session archival: summarize-then-delete, orchestrator-readable forever

## Context

`SessionManager.delete` (`apps/server/src/sessions/manager.ts`) hard-deletes
a Session's `messages` and `sessions` rows — once deleted, a Session's
history is permanently gone. The user's own framing for this decision:
"since we have a orchestrator/global agent, when we remove a session,
compact it and store it, so we could reference old sessions in the
orchestrator for context or questions." This was flagged as step 2 of a
2-part plan when ADR-0023 (session compaction) landed, deliberately
sequenced after it — archival's summarization step reuses ADR-0023's
mechanism directly rather than building a second, separate one.

The orchestrator (ADR-0021) already has a curated, purpose-built read-tool
surface for introspecting *live* Sessions
(`dilna_list_sessions`/`dilna_get_session`/`dilna_usage_totals`) — the
natural place to extend with the same pattern for *deleted* ones, per that
ADR's "curated read tools, not a generic SQL escape hatch" precedent.

`RepoManager.delete` (`apps/server/src/repos/manager.ts`) does not cascade
into a Repo's Sessions today — deleting a Repo leaves its `sessions`/
`messages` rows in place with a now-dangling `repoId`, the same tolerance
`usage_events` already accepts ("historical spend... a dangling id after a
session or repo is removed just renders as unknown client-side").

## Decision

**New `session_archive` table**, one row per archived Session, `sessionId`
as its own primary key (an archived Session is archived exactly once):
`sessionId`, `repoId`, `title`, `summary`, `createdAt` (copied from the
original Session), `archivedAt`. No FK to `sessions`/`repos` — deliberately
outlives both, same precedent as `usage_events` above; a Repo deletion never
touches this table.

**`SessionManager.delete` archives before it destroys**, for ordinary
(`kind: "session"`) Sessions only — orchestrator Sessions are excluded, same
as ADR-0023's compaction (no coding content worth referencing, and no
existing orchestrator instance would typically be the one reading its own
archive). Sequence: stop the live Agent if any → generate a final summary →
insert the `session_archive` row → *then* run the existing worktree/branch/
`messages`/`sessions` cleanup unchanged. This ordering is load-bearing: the
whole point is a Session's content survives deletion, so the archive row
must exist before the source rows are destroyed, not after.

**Summarization reuses ADR-0023's `generateSummary` call, not a new
mechanism** — new `pi.ts` function `summarizeSessionForArchive(provider,
modelId, history, priorCompaction)`: if the Session already has a stored
compaction (`sessions.compactedSummary`), only the tail *after* its
cutoff needs summarizing, passed as `generateSummary`'s `previousSummary`
(the same "update, don't re-summarize from scratch" call ADR-0023's
Addendum added for repeat compactions) — producing one final summary
covering the whole Session, not a summary-plus-retained-tail (there's no
live `Agent` left to keep serving a tail to). If nothing happened since the
last compaction, its existing summary is reused verbatim, no LLM call. A
Session with zero messages (deleted before its first turn) isn't archived —
nothing to summarize.

**Archival is best-effort, not a hard blocker on delete.** A resolution
failure (provider/model no longer in dilna's catalog) or a summarization
call failure is caught, logged, and deletion proceeds with no archive row —
the same "log and swallow, don't fail the caller" pattern ADR-0023's
compaction check and `runTurn`'s changed-files recompute already use. A
Session delete failing outright because an LLM call failed would be worse
than an occasional un-archived Session.

**Orchestrator gets two new tools**, mirroring `dilna_list_sessions`/
`dilna_get_session`'s split exactly:
- `dilna_list_archived_sessions({ repoId? })` — id/title/repoId/timestamps
  only, no summary text (ADR-0021's "not a full transcript dump, to keep
  context bounded" precedent applies the same way here).
- `dilna_get_archived_session({ sessionId })` — one archived Session's full
  summary.

`apps/server/src/sessions/archive.ts` (new file) owns the read/write pair
(`archiveSession`/`listArchivedSessions`/`getArchivedSession`) the same way
`repos/memory.ts` owns `getRepoMemory`/`setRepoMemory` — one place, no
scattered direct table access.

## Why not the alternatives

- **A generic search/filter tool over archive content**: rejected for now,
  same reasoning as ADR-0018's "no eviction/summarization... revisit if real
  usage shows agents failing to self-curate" — list + get-by-id is enough to
  start; a keyword or semantic search layer is real infrastructure with no
  proven need yet.
- **Cascading a Repo's archived Sessions on Repo delete**: rejected —
  `RepoManager.delete` already doesn't cascade live Sessions either, and the
  whole point of archival is that a Session's summary should survive things
  that would otherwise destroy it. Matches `usage_events`'s existing
  dangling-id tolerance rather than introducing an inconsistent new rule.
- **Blocking delete until archival unconditionally succeeds** (retry loop,
  error surfaced to the user): adds real complexity (retry policy, a way to
  represent "delete pending/failed" in the UI) for a failure mode
  (provider/model briefly unavailable) that's rare and, worst case, costs
  one Session's summary — not worth it against "ship small."
  Best-effort-and-log is reversible if usage shows it's actually a problem.
  This is also why the delete call is a straightforward `await`, not a
  background job with its own status: the summarization call adds real
  latency to `DELETE /api/sessions/:id` (a few seconds, one more model
  call), accepted as the cost of the correctness ordering above rather than
  built around with a two-phase/soft-delete flow — a Session delete is an
  infrequent, deliberate action, not a hot path.
- **A web UI to browse archived Sessions**: out of scope — the user's own
  framing was specifically "reference old sessions in the orchestrator,"
  not a Trash view. The `session_archive` table and `archive.ts` read
  functions are generic enough that a future UI could reuse them without
  rework, but nothing here builds toward one speculatively.

## Consequences

- New `session_archive` table (migration); empty until the first ordinary
  Session is deleted post-merge — nothing retroactive for Sessions already
  deleted before this shipped.
- `DELETE /api/sessions/:id` gets measurably slower for a Session with any
  message history (one more LLM call in the critical path) — the web
  client's delete button has no loading/optimistic-removal state today, so
  the row stays visible for that duration with no feedback. Not addressed
  here; worth a small follow-up if it reads as broken in practice.
- `pi.ts` gains `summarizeSessionForArchive`, reusing `checkSessionContext`'s
  same `resolveModelById`/`summarizationModels`/`generateSummary` machinery
  — no new provider/auth plumbing.
- Orchestrator Sessions (ADR-0021) are excluded from archival, same as
  ADR-0023's compaction — deleting one is still an unconditional hard
  delete, unchanged.
- The orchestrator's tool surface grows to seven tools; `ORCHESTRATOR_SYSTEM_PROMPT`
  is updated to mention the two new ones and when to reach for them (a
  Session that no longer shows up in `dilna_list_sessions` may have been
  deleted-and-archived, not merely never having existed).
