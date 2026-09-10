# Regroup a turn's persisted rounds into one message via `Message.turnId`

## Context

ADR-0026 §3 made turn durability incremental: `sessions/manager.ts`'s
`runTurn` persists each completed pi-agent-core *round* as its own `messages`
row, as soon as `turn_end` fires, instead of only persisting the whole turn at
the end. That narrowed a hard kill's loss window from "the whole assistant
response" to "whatever round was in flight". It also, as an accepted side
effect, changed **row granularity**: one user turn can now produce several
consecutive `Message{role:"assistant"}` rows where it previously always
produced exactly one.

ADR-0026's Consequences section claimed this needed no UI work beyond
`Message.role`'s new `"system"` value, on the grounds that:

> The web client's existing `showAttribution`/consecutive-same-role grouping
> (`ChatShell.tsx`) already renders consecutive same-role rows without
> repeating the avatar/header.

That was true but incomplete, and it shipped a UI regression. The *live* view
never split a turn: `agents/pi.ts`'s `NormalizeState.currentMessageId` pins one
dilna `messageId` per turn specifically so that

> the live UI renders one growing message with one tool-call group instead of a
> separate message per round

— so while a tool-heavy turn streams, every round's text and tool calls
accumulate into one `LiveMessage`, one `ChatMessageRow`, and one
`ToolCallGroup` (the collapsible "N tool calls — Read, Bash, Grep" section).
The moment the turn ends and `ChatShell`'s terminal-status handler reconciles
against the DB, the live entries are dropped in favour of the persisted rows
(matched by id, and persistence mints a *fresh* id per round, so no live entry
ever matches a row). The grouped turn was replaced by N separate messages,
each with its own attribution header and its own one-call tool group.

The user-visible symptom was therefore: chats grouped tool calls correctly
while streaming, then "refreshed" into an ungrouped wall of messages when the
turn finished. Consecutive-same-role rendering was doing its job — it just
renders N messages *without repeating the header*, which is not the same thing
as rendering one message.

## Decision

Give a turn an explicit identity in the persisted model, and regroup on it.

- **`Message.turnId`** (`packages/shared/src/messages.ts`), required and
  nullable (`string | null`), backed by a new `messages.turn_id` column
  (migration `0021_message_turn_id.sql`). Required despite being nullable:
  "this row belongs to no turn" is a real state every producer must state, and
  an optional field would give `undefined` a second, silently-equivalent
  encoding of it — forcing every consumer to normalize both.
- **Minted once per turn** in `SessionManager.runTurn`, as a plain
  `randomUUID()`, and threaded into *both* paths that can write a turn's rows:
  the incremental `persistRoundEvent` (per-round, on `turn_end`) and the
  turn-end safety net `persistMessagesFromAgent` (whole-turn, via
  `piMessagesToDilna`). Both converters stamp it on the assistant rows they
  produce.
- **`turnId` is not a per-round value and not a row id.** Rows keep their own
  primary keys; several rows share one `turnId`. Reusing one id across rows
  would collide on the primary key, which is exactly why the grouping signal
  is a separate column rather than "make persistence reuse the live
  `messageId`".
- **Null means "never grouped"**, and is never matched against another null.
  User rows, `"system"` boot-time interruption notices (ADR-0026 §2), and
  every pre-migration row carry null, so a legacy Session renders exactly as
  it did before this change.
- **The web client regroups** in `apps/web/src/lib/live-messages.ts`, via two
  pure functions the `ChatShell.rendered` memo now just calls:
  `mergeRenderedMessages` (persisted rows + live entries → the rendered list)
  and `foldTurnRows` (consecutive rows sharing a non-null `turnId` → one
  message). Parts are concatenated in row order (which is stream order),
  keeping the first row's `id` and `createdAt`. The restored shape is the same
  one `ToolCallGroup` was already built against, so no renderer changes were
  needed beyond the fold — the grouped turn comes back, with its tool calls
  adjacent in a single `parts` array.
- **Both operate on `Message[]`**, not a locally-declared message-ish shape.
  `turnId` living on the shared `Message` is what makes the fold expressible
  without the web side redefining the contract `packages/shared` owns
  (`CLAUDE.md`).

## Why not revert to one row per turn (the alternative ADR-0026 rejected)

The obvious fix is to undo §3's granularity: persist one row per turn again
and let the renderer's existing grouping do the rest. That was rejected here
for the same reason ADR-0026 rejected it, plus a new one:

- It re-opens the **upsert path**. Persisting one row per turn incrementally
  means rewriting that row as each round completes, but `messageStore`'s
  `persistMessage` deliberately throws on a primary-key collision (its doc
  comment says so, pointing re-persisters at `persistConverted`). ADR-0026
  chose `turn_end` timing *specifically* to avoid needing an upsert — an
  assistant `message_end` fires before its tool calls execute, so per-round
  writes would need a second patch-write once results land. Reverting
  reintroduces that.
- It **discards the durability granularity** the OOM incident bought. One row
  per turn means every round rewrites the same row, so a crash mid-write can
  now damage the already-persisted part of the turn, not just the in-flight
  round.

Keeping per-round rows and grouping on read costs one nullable column and one
pure function, and leaves the durability properties ADR-0026 established
intact.

## Why not infer the boundary from `createdAt` adjacency

No schema change, but the rows carry no turn identity, so grouping would have
to guess from timestamps. `messageStore.persistConverted` already contains a
timestamp-drift fix-up for legacy claude.ts-era rows that land minutes in the
future, and a separate block that re-stamps the turn's user row against the
pending placeholder's `createdAt` — i.e. this codebase has already found
`createdAt` ordering unreliable enough to patch twice. Building the grouping
on top of it would inherit that unreliability, and a wrong guess merges two
unrelated turns into one message. An explicit id is both simpler and honest.

## Why not reuse `NormalizeState.currentMessageId` as the row id

Tempting — it's already the per-turn identity the live view uses, so reusing
it would make the persisted and live shapes agree by construction. Rejected
because that id is minted *lazily*, by the normalizer, on the first assistant
frame: a turn that fails before producing any content never mints one at all,
yet still needs a turn identity for whatever it did write. It is also owned by
the adapter's normalization state, which is the wrong module to depend on for
a persistence invariant. Minting in `runTurn` is unconditional and keeps
`turnId` a manager-level concern, matching where the turn lifecycle already
lives.

## Consequences

- A reload, a session switch, or a second device now renders a multi-round
  turn as the same single message the live stream showed. Grouping survives
  the live→persisted handoff because the handoff no longer changes the shape.
- Every Session's history is now groupable on read; pre-migration rows keep
  rendering ungrouped (null), which is the same rendering they had — so no
  backfill migration is needed and none was written.
- `foldTurnRows` is deliberate about *adjacency*: rows only merge when
  consecutive in the list. Turn rows are always written contiguously (nothing
  else writes to a Session mid-turn), so this holds in practice, and
  requiring it means a future writer that interleaves rows can't silently
  merge a turn across an intervening user message.
- The two converters in `agents/pi.ts` now both take a *required* `turnId`.
  Every caller is persisting a specific, known turn (`runTurn` mints one per
  turn and threads it through), so a default would only ever encode an
  unreachable "this round belongs to no turn" state.
- `apps/server/src/db/schema.ts`, `apps/server/drizzle/0021_message_turn_id.sql`,
  `apps/server/drizzle/meta/_journal.json`, `apps/server/src/agents/pi.ts`,
  `apps/server/src/sessions/manager.ts`,
  `apps/server/src/sessions/messageStore.ts`, `packages/shared/src/messages.ts`,
  `apps/web/src/lib/live-messages.ts` and `apps/web/src/components/ChatShell.tsx`
  all changed. Coverage added in `pi.test.ts` (both converters stamp the
  caller's `turnId`), `manager.test.ts` (every round of one turn shares one
  `turnId` while keeping distinct row ids; the user's row stays ungrouped) and
  `live-messages.test.ts` — `foldTurnRows` (merging, ordering, unequal turns,
  null-never-merges, adjacency, non-mutation, `sessionId` survival) and
  `mergeRenderedMessages` (the persisted+live join: a real post-reconcile turn
  regroups to one message, two turns stay apart, the streaming and settled
  shapes match, id-shadowing precedence, and a live entry never folding into
  an adjacent persisted turn). `legacy-upgrade.test.ts` drives the migration
  against a DB already at 0020.

## Addendum: the granularity mismatch left in ADR-0026

While implementing this, a related inconsistency surfaced and was **not**
fixed here, because it is a persistence-correctness question rather than a
rendering one. `piRoundToDilnaMessage` converts one round into one row, but
the turn-end safety net still calls `piMessagesToDilna`, which collapses the
*whole* turn into a single row. Both can write for the same turn, and
`persistConverted`'s dedup is id-based — the two converters mint different ids
for the same content, so a retry slice that overlaps an already-incrementally-
persisted round can produce duplicate assistant rows.

This ADR is neutral on the fix (either the safety net should slice per round,
or the overlap should be made impossible), and stamping both paths with the
same `turnId` at least makes any such duplicate visible as two rows in one
group rather than two unrelated-looking messages.

Tracked as issue #190.
