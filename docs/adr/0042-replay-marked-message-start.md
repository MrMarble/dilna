# A replayed turn announces itself, so a subscriber that already holds it rebuilds instead of merging

## Context

Issue #244: on an active Session, after some messages, the assistant's output
starts repeating — the prose duplicated *inside* its own bubble, and every tool
call shown twice. Once the turn ended and the turn-end refetch landed, the
message corrected itself: `8` tool calls instead of `16`, one sentence instead
of two. That self-correction is the tell. The corrupted copy was the *live*
overlay; the DB rows were always right.

The two numbers are the fingerprint of a fold applied twice. ADR-0014's
mid-turn snapshot is a **re-narration**, not a delta: `SessionManager.subscribe`
hands a subscriber that joins mid-turn a synthetic event sequence —
`message_start`, then every accumulated part as if it were streaming again
(each text part as one `token`, each tool call as `tool_call_start` +
`tool_call_end`). The consumer folds those into accumulated parts via
`applyEventToParts`, where:

- `token` **concatenates** onto the trailing text part (`last.text + ev.chunk`);
- `tool_call_start` **appends** a new part, unconditionally.

Only `tool_call_end` is idempotent — it fills its matching part in place, and a
`callId` that matches nothing returns the same array by reference.

**Re-subscribing is normal, not exotic.** ADR-0016 §4's client closes and
reopens the stream whenever it goes quiet for 30s (the "open but not alive"
case native `EventSource` retry doesn't cover), and native retry reopens it
too. So the replay routinely lands on a subscriber that is *reconnecting* —
one that already holds, in its live map, the very message the replay
describes. ADR-0014's stated invariant ("replayed and live-from-the-start
subscribers converge on identical state") only ever held for a subscriber
starting from empty, which is the case the existing tests covered.

The client's `reset` (run as part of the on-open routine) clears `live` — but
deliberately not `messages` — so it does not help here: the replayed events and
the real turn's own still-arriving events are both folded into the same
`messageId`, interleaved in whatever order the transport delivers them. The
client cannot infer "this is a re-narration" from arrival order, because a
replay's events are ordinary `token`/`tool_call_*` shapes.

## Decision

**Mark the replay on the wire: `message_start` gains an optional `replay:
boolean`.** It is set by the one producer that re-narrates —
`liveTurnReplayEvents` — and absent everywhere else, so the marker is exactly
"this opens a message you may already have, and what follows describes it in
full."

**A consumer that already holds that `messageId` rebuilds from empty.**
`applyEventToParts` returns `[]` for a `message_start` with `replay: true`,
which is what makes the fold converge rather than accumulate. Both sides get
this for free from the one shared rule:

- **web** (`chat-reducer.ts`): the `message_start` case was idempotent — "a
  message the tab already knows keeps its entry" — which is correct for the
  real start and wrong for a replay. A replayed start now resets the entry's
  parts (keeping its `startedAt`: that is this tab's own clock for a message it
  is already displaying, and the replay carries no timestamp to re-stamp it
  with).
- **server** (`applyEventToLiveTurn`): already opened a fresh snapshot on any
  `message_start`, so it was never affected — the marker is a no-op there. The
  per-session snapshot is the server's own single-slot view; the bug only
  existed on the client, whose map outlives the replay.

**The field is optional and additive.** Absent means "an ordinary start". A
consumer that ignores it behaves exactly as before, so this is wire-compatible
in both directions — a newer client against an older server simply never sees
the marker, and an older client against a newer server ignores it.

## Why not the alternatives

**A separate `turn_replay` directive**, mirroring how `resync` is already a
directive the client acts on. Rejected: the directive would have to arrive
before the replay's `message_start` to be useful, which is a second ordering
guarantee on the stream for a fact the replay's own opening event can state
directly. It also splits one meaning across two events — a client that missed
or mishandled the directive would fall back to the bug, where the marker is
carried by the event that causes the harm.

**Client-side ordering**: have `reset` drop the live entries for the message
being replayed. Rejected: `reset` runs from the connect callback, which is not
synchronised with the replay's arrival, and it cannot cover the interleaving —
real content events from the live turn are still landing while the replay is
folded. Nothing on the client can distinguish the two.

**Making `tool_call_start` idempotent by `callId`** (upsert rather than append).
This would fix the doubled tool calls, but not the duplicated prose —
`token` would still concatenate — and it would be wrong in the general case:
two tool calls sharing a `callId` are not something the protocol guarantees
against, and silently merging them would lose a part. It also treats a symptom
(the parts are idempotent) rather than the cause (the replay is being merged).

**Not replaying at all**, and letting a reconnecting tab rebuild from the DB.
Rejected: this is exactly the gap ADR-0014 exists to close. Mid-turn the DB has
no row for the in-flight assistant message, so a tab that reconnects during a
tool-heavy turn would render nothing until the turn ended — the blank-pane
symptom that ADR was written to fix.

## Consequences

- The mid-turn replay is idempotent against **any** starting state: empty,
  partially streamed, or already complete. That makes the reconnect path safe
  to take as often as the staleness check decides it needs to.
- `applyEventToParts`'s identity contract is extended rather than broken: it
  still returns its input by reference for every event that changes nothing.
  A replay start is the one input that discards, and it is the one input where
  discarding *is* the correct behaviour.
- The invariant is stated where the events are, so it survives a new consumer:
  `AgentStreamEvent`'s `message_start` documents why the marker exists, and any
  future accumulator has a single documented reason to check it.
- Coverage added at four seams: the shared fold (`liveMessage.test.ts`), the
  client fold (`chat-reducer.test.ts`), the replay producer
  (`liveTurn.test.ts`), and the real `SessionManager.subscribe` path
  (`manager.test.ts`) — the last driving the public interface a client actually
  talks to, so the doubled-tool-call symptom is asserted end-to-end.
- Out of scope, unchanged: the event union's membership (this adds a field, not
  a variant), the resync routine of ADR-0016 §4, and the turn-end refetch that
  was papering over the corruption.
