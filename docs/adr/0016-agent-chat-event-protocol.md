# Agent-chat event-protocol contract: status, failure, stop, reconnect, in-turn feedback, multi-client

## Context

A code review (2026-07-14) diagnosed five reliability failures in the chat
path — a terminal `idle` racing persistence and dropping the just-flushed
assistant message, cold-start sends dropping the optimistic user bubble,
post-202 failures dying in `console.error` while the client spun forever, an
`EventSource` with no error/liveness handling (and server `message_replay`
events no client ever listened to), and a Stop button that killed the whole
agent process. Each fix touched the same underlying gap: dilna had event
*shapes* (ADR-0006) but no event *protocol* — no ordering guarantees, no
failure contract, no liveness story, and nothing carried on the stream during
long tool-heavy stretches.

This ADR locks that protocol. It was charted and resolved ticket-by-ticket on
[Map: agent-chat event-protocol spec](https://github.com/MrMarble/dilna/issues/32);
each section below gists one resolution and links the ticket holding its full
detail and rationale. Standing decisions it builds on: the DB is the source of
truth (ADR-0004), the shared event/message union is the contract (ADR-0006),
turn durability and mid-turn replay (ADR-0014).

## Decision

### 1. Turn-lifecycle status ([#33](https://github.com/MrMarble/dilna/issues/33))

- The status union stays `idle | starting | working | stopping | crashed`.
  `SessionManager` is the **sole** emitter of `session_status`; adapters
  signal turn completion internally and never reach subscribers directly.
- Turn sequence: warm send `working` → terminal; cold send `starting` →
  `working` → terminal. Status is **monotonic within a turn** — no mid-turn
  `idle` — and `working` precedes all of the turn's content events on the
  per-session stream.
- **Terminal durability gate**: a terminal status (`idle`/`crashed`) is
  emitted only after the turn's recoverable content is durable (assistant
  rows persisted, or the pending-user placeholder promoted on persistence
  failure). Client rule: *any terminal status ⇒ a history refetch is safe and
  complete* — unconditionally.
- Every transition runs through **one manager function**: DB write →
  per-session broadcast → global mirror. Ordering guarantees attach to the
  per-session stream; the global stream is a best-effort mirror.
- Every new per-session subscriber receives one authoritative opening status
  (in-flight phase if a turn is live, else persisted DB status; crashed
  sessions open `crashed`). All status events are **level-based**:
  duplicates permitted, clients treat them idempotently.

### 2. Failure surfacing ([#34](https://github.com/MrMarble/dilna/issues/34))

- **The 202 invariant**: every accepted send ends in exactly one terminal
  status; on failure, exactly one `turn_failed` event precedes it. The turn
  slot and the pending-user row are claimed **synchronously at accept**,
  before any spawn — the pre-202 **409** is therefore the only
  duplicate-send surface, and post-202 "already busy" is structurally
  impossible.
- One failure event replaces `error` and `agent_crashed` in the
  subscriber-facing union:

  ```ts
  { type: "turn_failed";
    class: "spawn_failure" | "agent_crash" | "turn_timeout"
         | "turn_error" | "persistence_failure";
    message: string;
    detail?: { exitCode?: number; stderrTail?: string[] } }
  ```

- Class → terminal mapping follows one rule — **`crashed` ⇔ no usable agent
  process remains; `idle` ⇔ the process is alive and reusable**:
  `spawn_failure`/`agent_crash`/`turn_timeout` → `crashed`;
  `turn_error`/`persistence_failure` → `idle`.
- **Retry is always "send again"**: any terminal status unlocks the
  composer; `crashed` cold-starts the next send, `idle` reuses the warm
  process. No retry endpoint, no client failure state machine.
- An unresumable Claude session is degraded success, not failure: a
  transient, non-persisted `notice { message }` event during `starting`,
  rendered as an unobtrusive inline line.

### 3. Stop/interrupt ([#35](https://github.com/MrMarble/dilna/issues/35))

- Stop aborts the in-flight turn via the SDK's `interrupt()` (an
  `AbortController` per turn wired into `chatClaude`'s `abortSignal`); the
  process stays warm and the session lands `idle`. A user stop is a **clean
  ending — no `turn_failed`**.
- Sequence `working|starting` → `stopping` → `idle`, all through the single
  transition point. Stop during `starting` completes the spawn, skips prompt
  dispatch, and keeps the warm process; the pending-user row stays in
  history.
- Partial output persists through the one shared turn-end persistence path;
  a post-`idle` refetch shows the truncated turn. No "stopped here" marker
  in the durable record.
- `stopping` is bounded (~10s): on expiry the manager kills the process and
  routes `turn_failed(turn_timeout)` → `crashed`. No new failure class.
- `POST /:id/stop` is **accept-and-stream** (returns once `stopping`
  registers; the outcome arrives on the stream), **idempotent** (repeats
  absorbed without restarting the escalation clock), and a **no-op success
  out of turn**.

### 4. Reconnect, resync, liveness ([#36](https://github.com/MrMarble/dilna/issues/36))

- **Refetch-based resync, no event ids.** Every stream open — first connect,
  native retry, manual reconnect — runs one client algorithm: reset
  live-turn state → refetch history via REST → apply the opening snapshot.
  No `Last-Event-ID`, no server event buffer; #33's terminal guarantee makes
  refetch sufficient, and level-based events make it idempotent.
- **Snapshot rule: reproduce what a live viewer of the current state would
  have seen.** Beyond the authoritative status and live-turn replay
  (ADR-0014), the snapshot carries the last `turn_failed` while still
  current (retained until the next accepted turn, emitted *before* the
  status to preserve #34's ordering) and an in-flight turn's `notice`.
- **Liveness**: a named `ping` event (~15s, transport-level, outside the
  shared union) on both streams. Any received event resets the client's
  staleness clock; silence past 2× the interval ⇒ close and reconnect with
  exponential backoff (~1s → 30s cap) alongside native retry. `onopen` is
  the single resync point; `onerror` only marks the connection degraded.
- **UI**: nothing while healthy; after ~3s of degraded state a quiet
  "reconnecting…" pill; the composer stays enabled (sends are REST).
- **`message_replay` is deleted** — route block and union entry. History
  travels exclusively via REST refetch.

### 5. In-turn feedback ([#38](https://github.com/MrMarble/dilna/issues/38))

Three additive events, all **transient** — nothing here persists, no new
`MessagePart`:

- **`turn_activity`** — a level-based coalesced snapshot of current
  activity, extending #33's level philosophy:

  ```ts
  { type: "turn_activity";
    phase: { kind: "requesting" | "compacting" | "retrying";
             attempt?: number; maxRetries?: number } | null;
    runningTools: { callId: string; tool: string; startedAt: number }[];
    tasks: { taskId: string; description: string; lastTool: string;
             toolUses: number; startedAt: number }[];
    thinkingTokens?: number;  // redacted-phase counter
    serverTime: number }      // client clock-skew correction
  ```

  The manager owns the aggregate (fed by the SDK's `status`, `api_retry`,
  `tool_progress`, `task_*`, `thinking_tokens` messages) and re-emits **only
  on discrete changes**; timers tick client-side from `startedAt` +
  `serverTime`. Valid only inside a turn: never emitted after the terminal
  status, cleared by the client on any terminal, present in the opening
  snapshot only mid-turn.
- **`thinking`** — `{ type: "thinking", messageId, chunk }`, an additive
  mirror of `token` fed by `thinking_delta` frames. Invariant: `token`
  chunks are exactly what persists; `thinking` chunks are exactly what
  doesn't. Discarded client-side at that message's `message_end`.
- **`resync`** — a directive: the client re-runs its standard on-open
  routine (§4). Idempotent. Sole producer today is refusal-fallback
  retraction (`retracted_message_uuids`): the manager evicts the retracted
  content from its live-turn snapshot, sets a transient `notice`, emits
  `resync` — retraction never introduces removal semantics into the client.

Deferred without protocol impact: partial tool input (`input_json_delta`)
and `tool_use_summary`. `forwardSubagentText` stays off — task visibility is
built from the unconditional `task_*` events only.

**Rendering** (validated against alternatives by prototype
[#41](https://github.com/MrMarble/dilna/issues/41)): inline markers plus one
conditional strip — elapsed badge on the running tool row, a task activity
line under its spawning Task call (`parent_tool_use_id`), a thinking
header+preview block in the streaming assistant bubble (expandable, degrades
to the token counter under redaction, vanishes at message end), and a phase
strip above the composer rendered only while a phase is active.

### 6. Multi-client ([#39](https://github.com/MrMarble/dilna/issues/39))

- **Every connected client is an equal subscriber.** No event, status, or
  capability is addressed to "the tab that sent"; sender and non-sender
  receive the identical stream. The only sender-private artifact is the
  optimistic user bubble between click and 202; the composer draft is
  tab-local by design.
- At accept the manager broadcasts `user_message { message: Message }` (the
  complete persisted row) and the **202 response body carries the same
  row**: the sender swaps optimistic → authoritative by id and drops the
  broadcast duplicate; non-senders append; mid-turn joiners get it via
  refetch. All clients converge on one row id — the idle-time reconcile
  heuristic for user bubbles disappears.
- Concurrent sends stay **409-only** (§2); the rejected tab keeps its draft,
  shows a quiet inline notice, and is already rendering the in-flight turn
  it lost to. Server-side send queueing is out of scope.
- **Stop is session-scoped**: any subscriber may stop; §3's idempotency
  absorbs races; every tab renders the same `stopping` → terminal levels.

### The union after this ADR

Subscriber-facing `AgentStreamEvent`: `session_status`, `changed_files`,
`user_message` (new), `message_start`, `token`, `thinking` (new),
`tool_call_start`, `tool_call_end`, `message_end`, `turn_failed` (new,
replacing `error` + `agent_crashed`), `notice` (new), `turn_activity` (new),
`resync` (new), `usage_update`. Deleted: `error`, `agent_crashed`,
`message_replay`. Transport-level, outside the union: `ping`.

## Why not the alternatives

- **Adapter-emitted status** (status quo): the adapter can't know when
  persistence finished, which is exactly how diagnosis (a) happened. Only
  the manager sees both the turn and the DB write, so only it can honor the
  terminal durability gate.
- **Event ids + replay-based resync**: requires a server-side event buffer
  and versioned resume protocol to deliver what a REST refetch already
  guarantees for free under the terminal gate; level-based events make
  refetch idempotent, so the extra machinery buys nothing.
- **Server-side send queueing** instead of the 409: the SDK's input queue
  has no contents visibility, and queue ordering/cancellation/cross-tab
  rendering would be a second protocol's worth of decisions for a niche
  win. Ruled out of scope, revisitable as its own effort.
- **A `message_retract` event** for refusal retraction: precise, but it
  introduces removal semantics into the client's live state for one rare
  path. The `resync` directive reuses the routine every client already runs
  on open and covers any future retroactive mutation.
- **Typed per-signal activity events** (`tool_progress`, `task_*`, … passed
  through): edge-based — client state machines per signal and a multi-event
  snapshot replay, precisely what the status contract ruled against. One
  coalesced level keeps the client dumb and the snapshot trivial.
- **Persisting thinking** as a `MessagePart`: drags a DB migration and
  history rendering into a feedback feature; transient thinking loses
  nothing durable (refetch is the resync primitive) and persistence remains
  an additive later option.
- **Activity feed panel / status-strip-only rendering**: prototyped against
  the inline composition on a simulated busy turn (#41). The panel stacks a
  second right-hand sidebar beside the Context panel and divorces activity
  from the tool rows it describes; the one-liner starves overlapping
  activity (retry + long tool + subagent) and gives thinking text no home.

## Consequences

- The client's chat logic reduces to four rules: render levels as they
  arrive; refetch on every stream open and on any terminal status; clear
  transient state (`turn_activity`, `thinking`, live turn) at terminal
  status; treat `resync` as "run the on-open routine".
- `apps/server/src/agents/claude.ts` stops emitting `session_status`;
  adapter → manager turn-completion and crash signals become internal. The
  manager gains the single transition point, the turn-slot accept path, the
  activity aggregate, and the live-turn transient context (notice +
  last-`turn_failed` retention).
- `packages/shared` union changes (additions/deletions above) land in one
  change with both consumers, per ADR-0006.
- Implementation of this contract happens outside map #32 as its own
  effort; the five diagnosed bugs are fixed by implementing §§1–4 (each
  section names the diagnosis it resolves in its ticket).
