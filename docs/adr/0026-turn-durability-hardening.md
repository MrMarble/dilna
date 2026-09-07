# Turn durability hardening: graceful shutdown, interruption notice, incremental round persistence

## Context

Two production sessions on the operator's own instance
(`hTb3k-AYAdCwg5_Ul4kUS`, `bXBqdq3O6UC6BXMUr-eri`) lost their in-flight
assistant turns on 2026-09-07, ~13:17–13:28 UTC. Investigation (pod
description via `kubectl`) found the container was `OOMKilled` (exit 137) at
13:28:13 UTC: the deployment's memory limit was `1Gi`, far below what
`apps/server`'s own operational notes document `tsc --noEmit` alone needing
(`NODE_OPTIONS=--max-old-space-size=4096`) — a plausible trigger given the
second session's request ("add a `pnpm typecheck` job to CI... fix all of
them") very likely ran typecheck as part of the fix. The memory limit itself
was raised separately (`home-ops`, outside this repo) and isn't this ADR's
concern.

What *is* this repo's concern: both sessions ended with the assistant's
in-flight work, and even usage accounting, completely gone — final status
`idle`, no record anything had gone wrong. Root cause: `sessions/manager.ts`'s
`runTurn` persisted the assistant's output only in a `finally` block that
runs once the whole turn settles. A hard kill (`SIGKILL` from OOM, or an
unhandled `SIGTERM` on an ordinary deploy/restart) skips that block entirely;
on reboot, `resetAllToIdle` could only promote the user's pending placeholder
and silently flip the session to `idle`.

ADR-0020's Consequences explicitly accepted this as a trade-off of moving to
`pi-agent-core`'s in-process `Agent` (no independent transcript to recover
from, unlike the old `claude.ts`/Claude-CLI-subprocess backend) — but scoped
that acceptance to "a rare failure mode (a server crash specifically
mid-turn, not a resumable idle-kill or clean restart)" and explicitly
considered and rejected incremental persistence on that basis. A real,
reproducible incident changes that calculus: this ADR revisits it on the
terms ADR-0020 itself set, and adds two more findings from the same
investigation the OOM incident triggered.

## Decision

Three changes, independent of each other and of the infra memory-limit fix:

### 1. Graceful shutdown

`index.ts`'s `shutdown()` previously closed the DB and called
`process.exit(0)` immediately on `SIGINT`/`SIGTERM`, discarding any in-flight
turn regardless of how much time the caller (e.g. Kubernetes' default 30s
`terminationGracePeriodSeconds`) actually gave it to exit cleanly.

Now: `SessionManager.drain(timeoutMs)` flips an internal `draining` flag
(`beginTurn` rejects new turns from that point with a new
`SessionManagerDrainingError`, mapped to `503` at the route so the client can
retry against whatever pod comes up next) and waits, up to `timeoutMs`
(25s, comfortably under k8s's 30s default), for every currently in-flight
`runTurn` call — tracked via a new `runningTurns` map, populated by
`trackRunningTurn` at every call site — to reach its own existing
end-of-turn persist. `index.ts` also now flips `/api/health` to `503` the
moment draining starts (a readiness-gate signal so k8s stops routing new
traffic to a terminating pod) and captures `serve()`'s return handle to
actually call `.close()` on it.

This only helps against a signal the process can catch — `SIGKILL` (what an
OOM kill sends) bypasses all of this entirely; nothing running in-process can
intercept it. It helps against the much more common case: an ordinary
`kubectl rollout restart`, deploy, or node drain, all of which send
`SIGTERM` first.

### 2. Persisted interruption notice

`resetAllToIdle` now also writes a synthetic `role: "system"` `Message` row
("This turn was interrupted before it could finish — the server restarted
mid-response...") for every session it finds `working`/`starting`/`stopping`
at boot, alongside its existing pending-placeholder promotion. `Message.role`
(`packages/shared`) widens from `"user" | "assistant"` to add `"system"` — no
DB migration, since `messages.role` is plain unconstrained `text`. The web
client (`ChatShell.tsx`) renders a `system` row as an inline notice (reusing
the existing `Marker`/`MarkerIcon`/`MarkerContent` component already used for
the transient in-turn `notice` event), not a chat bubble.

This is a deliberate, narrow departure from ADR-0016 §5's `notice` event,
which is explicitly transient/non-persisted by design — but that decision is
about a *live, in-turn* hint to an already-connected client, a different
problem from this one: a durable record of an infrastructure event, which by
definition nobody was necessarily watching happen, that a client must still
see on reconnecting arbitrarily later. ADR-0016's actual scope (in-turn
feedback) is untouched; this is a new, narrowly-scoped concept limited to
boot-time interruption recovery.

### 3. Incremental persistence, one row per completed round

`sessions/manager.ts`'s `runTurn` now persists each completed "round" — one
resolved assistant message plus its tool results — as its own row as soon as
it's known-complete, instead of only at the very end of the whole turn. This
narrows a hard kill's loss window from "the whole turn" down to "whatever
round was still in flight."

Mechanism: pi-agent-core's raw `turn_end` event (previously silently dropped
by `pi.ts`'s `normalizePiEvent`) fires only after both a round's assistant
message *and* its tool results are already pushed onto
`agent.state.messages` (confirmed against the installed
`@earendil-works/pi-agent-core` build's `agent-loop.js`/`agent.js`) — so
there is nothing partial to guard against at that point, unlike
assistant-`message_end` alone (which fires *before* tool execution). A new
`piRoundToDilnaMessage` (`agents/pi.ts`) converts one round into a single
`Message` row, id minted once at the moment it's persisted. `runTurn`
subscribes directly to the raw `handle.agent` stream (independent of the
existing normalized `onEvent`/live-view stream) via a new `persistRoundEvent`
method, which also tracks `active.persistedCount` in exact step with
`agent.state.messages`'s real growth (pi's `agent-loop.js` pushes the user's
own prompt via one `message_end` before any round begins, then one
`message_end` per round's assistant message and each tool result before that
round's `turn_end`). The turn-end `persistMessagesFromAgent` call stays as an
unconditional safety net — a no-op in the common case once incremental
persistence has already caught `persistedCount` up, but still correct for
anything whose `turn_end` never fired (e.g. a crash strictly mid-round).

A stalled turn's abandoned background `chatPi` call (the existing
stall-timeout path already documents this: the losing call keeps running
`agent.prompt()` after `runTurn` gives up on it) is guarded by a
`turnSettled` flag, mirroring the existing `deliberatelyAborted` guard on
that same path — any round it completes after the turn is considered settled
is left for the *next* turn's wider, overlapping retry slice instead of
touching `active.persistedCount`, exactly the same fallback a persistence
failure already relies on.

**Row granularity changes**: a single dilna "turn" (one user message) can now
produce several consecutive `assistant`-role rows instead of always exactly
one merged row (`piMessagesToDilna`'s whole-turn collapse still exists, used
only by the safety-net path). The web client's existing
`showAttribution`/consecutive-same-role grouping (`ChatShell.tsx`) already
renders consecutive same-role rows without repeating the avatar/header, so
this needed no additional UI change beyond the system-role branch from
change #2.

## Why not a JSONL transcript file (like Claude Code / opencode)

Considered and rejected. The old `claude.ts` backend's crash recovery
(ADR-0014) worked because the Claude CLI ran as a genuinely separate OS
subprocess that flushed its own transcript independently of dilna's server
process — durability came from *process independence*, not "file beats
database." `pi-agent-core`'s bare `Agent` (ADR-0020) runs in-process — there
is no separate subprocess anymore, so whatever writes an incremental record,
file or DB row, is the same process at risk of `SIGKILL`. A file buys no
extra crash-safety here (if anything, SQLite's journaling is more
crash-consistent than a naive JSONL append, which can leave a truncated last
line). ADR-0006 also already rejected aggregating the live event stream into
a log twice (opencode, then again for this same
pi-agent-core-native-JSONL-`SessionManager` option, evaluated and declined in
ADR-0020) — a parallel file format would duplicate dilna's
single-source-of-truth SQLite store and need its own reader distinct from
`getMessages`/`/transcript`. Incremental DB rows reuse the existing
storage/read path; they're just written more often.

## Why not finer-grained (sub-round/per-token) persistence

Round-level is a deliberate middle ground, not the finest possible grain.
ADR-0020 considered per-`message_end` persistence and rejected it as "not
actually closing the gap... narrows the loss window, doesn't restore
Claude's independent-process guarantee, and adds real write volume/complexity
for a rare failure mode." Round-level (via `turn_end`, not raw
`message_end`) sidesteps the specific correctness problem that reasoning
didn't fully anticipate — an assistant `message_end` fires *before* its tool
calls execute, so persisting at that grain would need a second patch-write
once results land, requiring an upsert path the schema doesn't have. Waiting
for `turn_end` avoids that entirely at the cost of a coarser (but still much
narrower than before) loss window, and this ADR's premise — the failure mode
is no longer rare, it just happened in production — is what justifies
accepting the added write volume ADR-0020 weighed against.

## Consequences

- A hard kill (OOM or otherwise) now loses at most the currently in-flight
  round, not the whole turn — the transcript up to the last completed round
  survives; only pi's in-process `Agent` state is lost (already true either
  way, and already recovered from by cold-starting the next turn off dilna's
  own persisted history, per `startPi`'s existing cold-start path).
- A graceful `SIGTERM` (deploy, rollout restart, node drain) now waits up to
  25s for in-flight turns to finish instead of discarding them outright.
  `SIGKILL` is unaffected — nothing in-process can be.
- Every session interrupted by *any* restart, not just genuinely lost ones,
  now carries a visible, durable, boot-time system-role notice — a client
  reconnecting long after the fact sees why a turn stopped abruptly instead
  of silent nothing.
- `Message.role` gains a third value (`"system"`) purely for this boot-time
  notice — never produced by an agent backend, never a general precedent for
  persisting other transient signals (ADR-0016's `notice` stays exactly as
  specified).
- A turn's assistant content may now span multiple consecutive `Message`
  rows instead of always exactly one; nothing downstream (compaction, title
  derivation, context estimation) assumes single-row-per-turn, and the web
  client's existing consecutive-same-role rendering absorbs the change
  visually.
- `apps/server/src/sessions/manager.ts`, `apps/server/src/agents/pi.ts`,
  `apps/server/src/index.ts`, `apps/server/src/routes/sessions.ts`,
  `packages/shared/src/messages.ts`, and
  `apps/web/src/components/ChatShell.tsx` all changed; test coverage added in
  `manager.test.ts` (graceful shutdown, resetAllToIdle's notice,
  `persistRoundEvent` bookkeeping, and a simulated-mid-kill end-to-end case),
  `recovery.test.ts` (updated for the new notice row), and `pi.test.ts`
  (`piRoundToDilnaMessage`).
