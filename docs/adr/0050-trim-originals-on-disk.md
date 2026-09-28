# Store trim originals on disk, keyed by hash alone

## Context

Issue #272's seed-time `ToolOutputPolicy` made prior turns' tool outputs
lossy in the model's view: a 3,000-line `read` seeds as head + tail + a
marker carrying the path, the removed counts, and a sha256 of the original.
The persisted rows keep the verbatim text, so nothing was destroyed — but
the trim was only ever *safe* in the database's sense. A person reading the
transcript could see "330 lines removed, content sha256 abcd…" and have no
way to get those lines back without asking an agent to re-run the tool.
Issue #273 asked for the full original on disk under `<DILNA_DATA_DIR>/truncated/`,
recoverable by the hash in the marker, and served read-only from the chat UI.

Three questions the issue left deliberately open, settled here:

## Decision

**Keyed by hash alone, not by session.** The store is
`<DILNA_DATA_DIR>/truncated/<sha256-hex>` — one file per distinct content,
global across Sessions. Identical output trimmed in two Sessions is one
file (the acceptance criterion "identical content trimmed twice does not
store two divergent copies" falls out of the addressing, not a rule). The
cost is that a Session delete cannot name its files — another Session may
reference the same hash — which is exactly why lifecycle is answered by:

**Age, not ownership: entries are pruned 30 days after write.** A marker
older than 30 days may no longer resolve; the marker itself (persisted in
the transcript) still says what was removed and its hash, so nothing is
silently rewritten — only the recovery link expires. That bound is what
keeps the store from growing without end on a long-lived instance,
including originals belonging to Sessions deleted long ago: they age out on
the same clock as everything else. Pruning runs at boot and is throttled to
once an hour on the write path. (A per-session index with refcounting was
rejected: it re-introduces the session-keyed cleanup story content
addressing exists to avoid, to save disk a 30-day window already bounds.)

**Who writes: every caller that runs the seed walk.** Both the cold-start
seed (`SessionManager.startAgent`) and `GET /:id/messages` compute the trim
map from the verbatim rows — one walk, `collectSeedTrims`, two consumers —
and both pass the store hook. This is not redundant: the UI shows markers
derived from persisted state (they survive a reload by recomputation, not
replay), so a marker can be on screen *before the next cold start ever
runs*, and its link must work then. The route's write is a GET side effect
by design — cache-warming, never a mutation: the store is content-addressed
and idempotent, so the walk can create `<hash>`'s file but never change
what's in it. Writes land via temp-file-and-rename so a crash cannot leave
a half file at a content address.

**The UI renders the seeded form, not the verbatim rows.** A trimmed
`tool_call` part shows the head/tail + marker the model reasons over at the
re-seed boundary, with the marker line explicit and a "View original" link
to `GET /api/sessions/:id/truncated/:hash` (new tab, `text/plain`, the same
load-bearing header set as the attachment route — the bytes are tool
output, served from dilna's own origin next to an unauthenticated `/api`).
This deliberately revises #272's "the web transcript renderer must not
change": that held while trims were a model's-view concern only; #273 is
the ticket that makes truncation user-visible. The verbatim output is one
click away, not hidden — and the route is session-scoped (though the store
is global) so the URL names the Session a marker's link came from, which
issue #274's retrieval counter will attribute reads to.

`TrimmedToolOutput` gains a `reason: "size" | "dedup"` so consumers can
tell a size cut from a "same as turn N" dedup without parsing marker text.

## Consequences

- A truncated result stops being lossy: the marker names a hash, the hash
  names a file, and a human recovers it from the chat UI without an agent.
- `GET /:id/messages` recomputes the seed walk per request. That is the
  same CPU the cold start already pays (sha256 over tool outputs) and it
  buys the property the acceptance criteria demand: markers derive from
  persisted state, so a reload shows exactly what a cold start would seed.
- Storage growth is bounded (30 days), not eliminated; the store is empty
  on fresh installs and needs no migration (no DB involvement).
- The transcript live view still shows the turn's outputs verbatim — trims
  apply only to prior turns at the next cold start (unchanged from #272).

## Alternatives considered

- **Session-scoped store** (`truncated/<sessionId>/<hash>`): obvious GC on
  session delete, but duplicates shared content, breaks the "no divergent
  copies" criterion for identical output, and drags a cleanup hook into
  every delete path. Rejected.
- **Server-side session/permission check on the hash route**: there is no
  auth model to check against (self-hosted, single user — every route is
  unauthenticated); the hash is unguessable 256-bit space. The header set
  is the security boundary, as for attachments/artefacts.
- **Render verbatim output with a truncation banner on top**: keeps the
  transcript showing bytes the model no longer sees, which is the exact
  "why didn't the model see X" confusion this feature exists to end. The
  seeded form is the honest display; the link is the recovery.
