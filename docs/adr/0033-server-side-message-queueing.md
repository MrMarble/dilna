# Queue mid-turn sends server-side, drained into one turn at the turn boundary

## Context

The turn protocol is strictly single-turn-per-Session: `beginTurn` claims
the turn slot synchronously at accept, and a send that arrives mid-turn is
rejected with a pre-202 **409** — deliberately the *only* duplicate-send
surface (ADR-0016 §2). ADR-0016 also ruled a server-side send queue out of
scope at the time, revisitable as its own effort.

The user-facing cost was that the composer disabled itself for the whole
turn: with agent turns routinely running minutes, the user sat on a
finished thought — "also fix X", "when you're done, run the tests" — until
the agent went idle, or lost it.

A first iteration of this feature held the queue **in the browser**
(localStorage + an idle-triggered dispatcher in `ChatShell`). That was
rejected before merging for a reason fundamental to how dilna is used:
*work continues even when the user's machine is offline* is the product's
opening sentence. A client-held queue inverts that — lock the phone after
queueing a message and the tab is suspended, so nothing dispatches until
the user comes back to babysit the very agent they walked away from.

## Decision

The **server holds the queue** and drains it at the turn boundary; the
browser only mirrors it.

- **`queued_messages` table** (migration `0024`), fronted by
  `sessions/messageQueue.ts` — free functions over rows, in
  `messageStore.ts`'s style (ADR-0027). Ordered by SQLite's `rowid`
  (insertion order), not `createdAt`, whose second granularity lets two
  quick enqueues tie. An entry snapshots its already-uploaded attachments
  as JSON — safe because attachment rows only ever disappear with the whole
  Session, which deletes its queue too.
- **`POST /api/sessions/:id/queue`** accepts a mid-turn submission — same
  body schema and attachment resolution as the send route, 202 (accepted
  for later delivery). Deliberately a *separate endpoint* rather than
  making the send route queue on conflict: the send's pre-202 409 is the
  protocol's one concurrency surface, and a send that sometimes runs now
  and sometimes queues would make that contract ambiguous. `GET /:id/queue`
  serves the snapshot; `DELETE /:id/queue/:queuedId` withdraws an entry
  (idempotent — racing the dispatch is harmless either way).
- **Dispatch lives in `runTurn`'s `finally`** — the single line every turn
  (completed, failed, stopped, crashed) exits through — plus after every
  enqueue, which covers enqueue-while-idle and the race where the turn
  ended between the client's status snapshot and its POST. No browser needs
  to be open: the queue drains the moment the slot frees.
- **All entries drain as one combined turn** (texts joined by a blank line,
  attachments concatenated), not one turn each: the entries accumulated
  against the same in-flight turn, so they are one batch of "also do this"
  context the Agent should see together — and a single combined turn can't
  interleave with fresh direct sends the way a several-turn drain could.
  The drain claims the slot through the ordinary `beginTurn`, so the 202
  invariant and the 409 surface are untouched; losing the claim to a
  concurrent direct send just leaves the queue for the next boundary.
- **`queue_update` SSE event**, level-based like `changed_files`: every
  change broadcasts the whole queue, so every tab (and a second device)
  converges without diffing. The client's on-open resync fetches the REST
  snapshot, the same way history works (ADR-0016 §4).
- **The composer stays enabled during a turn.** A submit while the Session
  is busy — or while entries are already queued, so nothing jumps the
  line — POSTs to the queue endpoint; queued entries render in a tray
  above the composer, each removable until dispatched.

## Why not the client-held queue (the rejected first iteration)

- Dispatch required a live tab: a locked phone, a closed laptop, or
  navigating to another Session stalled the queue indefinitely.
- Every device had its own private queue with its own relative order;
  entries were invisible to other tabs until they became messages.
- It needed its own pause/resume state machine (failed turns, stops,
  restored-from-storage staleness) purely to compensate for the dispatcher
  living in an unreliable place. Server-side, those cases collapse into
  "the turn ended, drain the queue" — the drained turn is an ordinary turn
  whose failure is reported like any other.

The costs accepted by going server-side: one more table and endpoint
triple, and one more event type on the wire — all shaped like existing
pieces (`attachments`' endpoint/table pairing, `changed_files`' event).

## Consequences

- The user can keep talking while the agent works and then walk away;
  messages send themselves, in order, as the agent becomes free — phone
  locked or not. Refresh, session switching and second devices all show
  the same queue, because there is only one.
- A queued entry survives a server restart (it's a row); it dispatches at
  the next turn boundary — the next enqueue or the next turn's end.
- After a *failed* or *stopped* turn the queue still drains — the next
  turn's error reporting is the same as any direct send's. Simplicity was
  chosen over a pause-on-error state machine; if plow-on proves wrong in
  practice, a pause flag can be added to the table without touching the
  protocol.
- `ChatShell`'s textarea is no longer disabled mid-turn, and the Send
  button renders alongside Stop while working (mobile has no
  Enter-to-send, so queueing needs a visible button).
