# Give turn persistence bookkeeping a module (Turn Ledger)

## Context

A turn's rows reach the DB by two paths that overlap on purpose (ADR-0026):
an *incremental* one writing each round as it completes, and a turn-end
*safety net* writing whatever the first missed. Getting "exactly once" out of
two writers requires correlating two different kinds of fact:

- a **position** in `handle.agent.state.messages` — how far dilna has
  examined; where the safety net's slice starts.
- an **identity set** of the entries the incremental path actually wrote.

Both lived as plain mutable fields (`persistedCount`, `persistedRounds`) on
the `ActiveAgent` record in `sessions/manager.ts`, mutated from four sites
across ~700 lines: `startAgent`, `persistRoundEvent`, `persistMessagesFromAgent`
(via `runTurn`), and `checkContextAndCompact`. Correctness was a property of
the *set* of four call sites — no single place could be read to know the rule,
which was instead carried by ~60 lines of doc comment spread across them.

This was load-bearing, not theoretical. Issue #190 / `6054b98` is exactly the
two facts being conflated: `persistedCount` doubled as position *and* success
counter, so a round that failed to persist left it unadvanced while later
rounds advanced it, leaving it pointing past the failed round. The turn-end
slice re-offered an already-persisted round (a duplicate row, since the two
converters mint fresh ids and `persistConverted`'s dedup is id-based) and
never re-offered the failed one. ADR-0026 and `b0393dd` are further passes
over the same state. Three hardening passes, each documenting the rule better
without making it harder to break.

## Decision

Introduce `sessions/turnLedger.ts`: a `TurnLedger` that privately owns the
position and the identity set. `ActiveAgent` holds one `ledger` field instead
of two mutable ones, and the four mutation sites become four method calls:

- `examine(count)` — advance the position past entries that produced no row,
  or whose write *failed*. Failures must still advance it, or the position
  desynchronizes from the transcript.
- `recordRound(entry)` — this round's row is durable. Called only after the
  write succeeded.
- `settle(messages)` — the turn ended; return the gap still to be written.
  Pure: it moves nothing.
- `commit(messages)` — the gap is durable; advance, and start the next turn
  here.
- `rebase(messages)` — compaction replaced the transcript wholesale
  (ADR-0023).

`settle`/`commit` are split so "only advance once the write actually
succeeded" lives inside the module rather than at the call site, where it
previously took a returned `newPersistedCount` plus a comment to get right.

`runTurn` keeps its sequence. Per ADR-0027 the turn state machine's
invariants are properties of the *sequence*, so it is not split; this removes
state from *around* it without touching the ordering.

### The latent bug this surfaced

`settle` slices from a **turn-start mark**, not from the position. Wiring the
ledger through end-to-end exposed a real bug that survived #190's fix: since
that fix advanced the position unconditionally, at turn end the position
equals the transcript length, so `slice(position)` is *empty*. When every
round landed that is correct — but a round whose incremental write threw is
then never re-offered either, and is lost. The safety net could not do the
one job it exists for whenever the failing round was the turn's last.

The existing regression test missed it because it passed a literal `0` as the
slice start rather than the position production actually holds; nothing in
production supplies that `0`. The test now drives the real ledger, and fails
against the old behaviour.

Slicing from the turn's start re-offers the whole turn and lets the identity
set subtract the rounds that landed — which is precisely the position/identity
split this module exists to keep straight.

## Consequences

**Locality.** #190's class of bug is now a change in one file rather than a
re-audit of four call sites. `manager.ts` loses ~73 lines, most of it
invariant-explaining comment that became the module's interface doc.

**Testability.** Exactly-once persistence was previously reachable only by
driving a whole `runTurn` against a mocked agent with a real cloned fixture
Repo. `turnLedger.test.ts` covers the rule as pure sequences — *round A lands,
round B throws, turn settles → B is written once, A is not* — in 10 tests that
run in ~7ms, against ~625ms apiece for the manager tests that used to be the
only route to this behaviour.

**The deletion test passes.** Delete the ledger and the position/identity
correlation reappears at four call sites; the complexity is concentrated, not
moved.

## Why not the alternatives

**Leave it as fields with better comments.** This was tried three times
(#190, ADR-0026, `b0393dd`). Each pass improved the prose without changing
the fact that the invariant spans four mutation sites, and the fourth pass
found a bug all three had left in place.

**Merge the two pi→dilna converters.** Explicitly out of scope. They answer
different questions (incremental round vs. turn-end gap) and already share
`piRoundToDilnaMessage` as the single row-shape decision. #190 was a
*bookkeeping* bug, which is what this addresses.

**Expose the position as a public field.** It is readable (`position`) for
tests and logging, but nothing in production slices on it — `settle` does,
from a deliberately different mark. Making it writable would reopen exactly
the four-call-site problem.
