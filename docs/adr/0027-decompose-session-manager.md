# Decompose SessionManager into a lifecycle core plus collaborators

## Context

`apps/server/src/sessions/manager.ts` had grown to ~2100 lines in one class.
Issue #149 catalogued what was mixed into it: the turn state machine,
`messages` persistence, git worktree operations, SSE broadcasting and
subscriber bookkeeping, several families of timers, and usage/cost
accounting. The mixing was visible in the code — `create`/`delete`
interleaved DB reads, `git` argv arrays with their cleanup fallbacks, and
broadcast calls in a single method body.

Two concrete costs, beyond size:

**Untestable units.** Everything reachable only through `SessionManager`
required a real cloned fixture Repo and a real `git worktree add` to touch.
`persistConverted`'s timestamp-reconciliation rules (the legacy
future-stamp shift, the placeholder-timestamp handover) were exercised only
by a full turn against a spawned agent — which CI never runs — so in
practice they had no coverage at all. The existing tests that did reach
internals did so through `sessionManager as unknown as { ... }` private-access
casts.

**Retention bugs are invisible.** ADR-0016 §4/§5's opening-snapshot rules
were implemented as three `Map`s (`lastTurnFailed`, `lastTurnActivity`,
`lastNotice`) that each broadcast call site had to remember to mirror into
by hand, next to the broadcast itself. An event fanned out to live
subscribers but not recorded for replay (or vice versa) was a one-line
omission with no structural guard against it.

CLAUDE.md flags session lifecycle and persistence as ADR-conscious areas,
and issue #149 explicitly asked for a design decision rather than an
opportunistic refactor bundled into a batch of smaller fixes.

## Decision

Extract the co-located responsibilities into collaborators that
`SessionManager` composes, keeping the turn state machine itself intact.

New modules under `apps/server/src/sessions/`:

- **`messageStore.ts`** — every `messages` read/write, plus the pending-user
  placeholder protocol (`pendingUserMessageId`/`promotePendingUserMessage`),
  which is inseparable from the row shape it operates on.
- **`broadcaster.ts`** (`SessionBroadcaster`) — subscriber bookkeeping,
  per-session and global fan-out, and the retained ADR-0016 §4/§5 snapshot
  events.
- **`turnRegistry.ts`** (`TurnRegistry`) — turn-slot claim/release and
  ADR-0026 draining/`runningTurns` tracking.
- **`worktree.ts`** — the per-Worktree `git` shell-outs and `codegraph init`.
- **`liveTurn.ts`** — the live-turn fold and replay (moved verbatim; still
  re-exported from `manager.ts`, which is their established import path).
- **`usageAccounting.ts`** — the `sessions` total bump, its paired
  `usage_events` row, and the outgoing event rewrite.
- **`sessionStore.ts`** — row/domain/view mapping and the compaction-column
  pairing.

Two shape decisions worth recording:

**Retention happens inside `broadcast`, not at call sites.**
`SessionBroadcaster.broadcast` calls a private `record` that captures
`turn_failed`/`turn_activity`/`notice` on the way out. This makes "fanned out
but not retained" unrepresentable rather than merely discouraged, which is
the class of bug the previous shape invited. Callers ask for the snapshot
back via `getLastTurnFailed`/`midTurnSnapshot`, and invalidate it via the two
named clears (`clearTurnSnapshot` at accept, `clearInTurnSnapshot` at turn
end) that encode §4-vs-§5's different lifetimes.

**Free functions where there's no instance state, classes where there is.**
`messageStore`, `worktree`, `usageAccounting` and `sessionStore` are modules
of free functions, matching the existing `archive.ts`/`diff.ts`/
`usageStats.ts` convention — `getDb()` is already a singleton, so a class
would add construction ceremony for nothing.  `SessionBroadcaster` and
`TurnRegistry` are classes because they own mutable in-memory maps whose
lifetime is the manager's.

### What deliberately stayed in `SessionManager`

`runTurn` and everything it sequences: the stall watchdog, the
persist-then-transition ordering, `failTurn`'s `terminalized` guard, the
pending-placeholder drop-vs-promote decision, and the agent
spawn/idle-kill/crash paths.

These are not separable responsibilities that happen to sit together — they
are one invariant expressed as an ordering. "A turn ends in exactly one
terminal status, preceded by exactly one `turn_failed` on failure"
(ADR-0016 §2) is a property of the whole sequence, not of any step in it.
Splitting the sequence across objects would spread a single invariant over
several files, each individually simpler and collectively harder to verify —
the opposite of the goal. `ActiveAgent` stays owned by the manager for the
same reason: `persistedCount`'s advance-only-on-success rule (ADR-0026) is
meaningful only in relation to the turn that advances it.

## Consequences

`manager.ts` drops from ~2100 to ~1570 lines (~945 of which is code; this
codebase's doc comments are a third of the file and moved with their
subjects rather than being trimmed), and the extracted units are directly
testable: 30 new tests across `broadcaster.test.ts`,
`turnRegistry.test.ts` and `messageStore.test.ts` run in under a second with
no fixture Repo, no `git worktree add` and no spawned agent — including the
first real coverage of `persistConverted`'s timestamp reconciliation and of
the §4/§5 retention rules.

One intentional behaviour change fell out of unifying the two worktree
cleanup paths: `create`'s rollback (after a failed row insert) previously did
a bare `rmSync` when `git worktree remove` failed, leaving a stale entry in
the repo's worktree admin data. It now runs the same `worktree prune`
fallback `delete` always did. Otherwise no behavioural change is intended,
and no public API changed:
`routes/sessions.ts`, `routes/stream.ts`, `index.ts`, `repos/manager.ts` and
`agents/orchestratorTools.ts` are untouched. The existing 244 server tests
pass unmodified except for the three graceful-shutdown tests, whose
private-access cast now reaches one level deeper (`.turns`) because
`draining`/`runningTurns` moved onto the registry.

The turn state machine is still the largest thing in the file, and that is
the accepted outcome rather than a deferred one — see "What deliberately
stayed" above. If it does need splitting later, the seam would have to be
justified on the invariant, not on line count.

Out of scope, per issue #149's own framing: `agents/pi.ts` (1666 lines) is an
adapter around `pi-agent-core`'s `Agent`, not a manager class, so its
persistence-bridge and confinement-hook responsibilities need their own
analysis. `apps/web`'s `SettingsPage.tsx` and `ChatShell.tsx` are named in the
issue as a separate, smaller follow-up.
