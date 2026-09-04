# Session compaction: dilna-owned, budget-triggered, via pi-agent-core's freestanding compaction functions

## Context

dilna has no context-window management today. Every cold start of a Session's
`Agent` — first turn, post-idle-kill respawn, post-server-restart — goes
through `startPi`, which reseeds the full raw history via
`dilnaMessagesToInitialState` (`apps/server/src/agents/pi.ts`). A
long-running Session's context cost only grows; nothing shrinks it, so a
Session can eventually exceed its model's context window with no graceful
degradation — an unaddressed correctness gap, not a hypothetical one.

`pi-agent-core`'s bare `Agent` class — which dilna deliberately uses instead
of `AgentHarness` (ADR-0020; `AgentHarness` is otherwise-stubbed,
`HarnessNotImplemented` on every state-mutating call) — has no compaction
wiring at all. Compaction exists in the package as a set of freestanding
exported functions (`shouldCompact`, `estimateContextTokens`, `estimateTokens`,
`generateSummary`, `compact`, `prepareCompaction`, `findCutPoint`,
`DEFAULT_COMPACTION_SETTINGS`, from `@earendil-works/pi-agent-core`'s root
export) that a caller — normally `pi-coding-agent`'s own session/harness
layer — must invoke and persist the result of itself.

Two of those functions, `prepareCompaction` and `findCutPoint`, take pi's own
`Entry[]` (a session-log type carrying `seq`/`parentId` bookkeeping,
maintained by `pi-coding-agent`'s session store) rather than plain
`AgentMessage[]`. dilna has no equivalent log — it reconstructs
`AgentMessage[]` directly from its own SQLite `messages` rows
(`dilnaMessagesToInitialState`). The functions dilna actually needs —
`estimateContextTokens`, `shouldCompact`, `estimateTokens`, `generateSummary`
— all operate on plain `AgentMessage[]`, so they're usable without adopting
pi's `Entry` wrapper or its session-log data model.

`Model` objects from `getBuiltinModels()` (already resolved once per Session
in `pi.ts`'s `resolveConfiguredModel`) carry static `contextWindow`/
`maxTokens` fields. No provider returns "tokens remaining" per response —
only per-call `Usage` (input/output/cache/reasoning/total), which `pi.ts`
already accumulates into `turnUsage`. This matches how OpenClaw (a larger,
independent coding-agent harness reviewed for this decision) does it too:
pair a static per-model ceiling with self-tracked live usage, not a live
figure parsed out of the provider's response.

dilna's `messages` table doubles as the user-visible transcript (the web
UI's `ChatShell` reads it for scrollback). Compaction must shrink what's fed
back to the model on the next call, not what a user can scroll through — a
Session's history disappearing from the UI because the model no longer needs
it would be a visible regression with no upside.

This ADR only covers keeping a *live* Session's context bounded. A separate,
later ADR is expected to cover archiving a *deleted* Session's compacted
summary for the orchestrator (ADR-0021) to reference — deferred because it
depends on compaction already producing a summary shape worth reusing (see
Consequences).

## Decision

**Trigger — budget only, checked at `agent_end`.** After every turn, compare
`estimateContextTokens(agent.state.messages)` against the Session's resolved
`model.contextWindow` via `shouldCompact(...)`, starting from
`DEFAULT_COMPACTION_SETTINGS` (`reserveTokens: 16384`,
`keepRecentTokens: 20000`). No `overflow` (react to a provider truncation
error) or `manual` (user-invoked `/compact`) trigger yet — OpenClaw has
both, but dilna is shipping the one case that's an active, known gap today;
the others need a proven need first (matches ADR-0018/0021's "ship small,
revisit on real usage" precedent).

**Cut point — dilna picks it directly, not via `findCutPoint`/
`prepareCompaction`.** A small dilna-owned function walks backward from the
end of `agent.state.messages`, accumulating `estimateTokens` per message
until `keepRecentTokens` is reached, snapped to the nearest user-message
boundary. This avoids introducing pi's `Entry`/session-log data model into
dilna for logic that's a few dozen lines on its own.

**Summarization — `generateSummary(messagesToSummarize, models, model,
reserveTokens, ...)` called directly** against the prefix before the cut
point, producing one summary string. `generateSummary`'s `models: Models`
parameter turned out to only ever be used for one method call
(`models.completeSimple`, confirmed by reading pi-agent-core's
`completeSimpleWithRetries` source) — so rather than build a full `Models`
registry (provider list, auth resolution, model catalogs, the way
`pi-coding-agent`'s own harness does via pi-ai's `createModels()`), `pi.ts`'s
`summarizationModels` is a narrow single-method shim satisfying just that
one call, delegating to pi-ai's bare `completeSimple` function with the same
env-var API key lookup `startPi`'s `Agent` construction already uses.

**Live effect — mutate the running `Agent`'s state directly.**
`agent.state.messages = [syntheticSummaryMessage, ...retainedTail]`, so the
*current* Session's context actually shrinks immediately (the `Agent` class's
own doc comment confirms assigning `state.messages` is a supported
operation, not an internal implementation detail).

**Persistence — two new nullable columns on `sessions`:
`compactedSummary` (text) and `compactedThroughMessageId` (text, an
unenforced pointer into `messages`, no FK/cascade — same precedent as
`usageEvents`' dangling-id tolerance).** Written whenever compaction runs.
`messages` rows are never deleted or rewritten — full raw history stays
intact for the UI transcript regardless of how many times a Session has been
compacted. `startPi`'s reseed path checks for a stored `compactedSummary`;
when present, it seeds the `Agent` with
`[syntheticSummaryMessage, ...raw messages after compactedThroughMessageId]`
instead of the full raw history, so a respawn or server restart doesn't
re-run summarization and doesn't let the context balloon back to full size
before the next `agent_end` check.

**Orchestrator Sessions (ADR-0021) are excluded** — they're meant to stay
short and fire-and-forget; revisit only if that assumption stops holding.

## Why not the alternatives

- **Reactive-only (`overflow`) trigger**: simpler — no need to detect or
  react to a provider truncation/rejection — but the turn that overflows
  still fails once before any correction happens. A proactive budget check
  prevents the failure instead of recovering from it, for barely more code
  (a comparison after every turn dilna is already computing usage for).
- **Adopting `prepareCompaction`/`findCutPoint` (`Entry[]`-based)**: would
  require dilna to either maintain a parallel `seq`/`parentId` log alongside
  its own `messages` rows, or synthesize throwaway `Entry` wrappers on every
  compaction call, for logic ("keep the last ~N tokens, snapped to a turn
  boundary") simple enough to own directly against dilna's own message shape.
- **Deleting or rewriting `messages` rows to reflect compaction**: would
  shrink the web UI's visible transcript along with the model's context —
  the point of compaction is to shrink what's sent to the model, not what
  the user can review.
- **Manual `/compact` trigger**: dilna's chat has no slash-command surface
  today; would need new UI and API surface for a control with no proven
  demand yet.
- **Using `AgentHarness`'s `compact()` method**: it's the stubbed
  `HarnessNotImplemented` path (per ADR-0020's original finding, still true)
  — not usable regardless of trigger/persistence design.

## Consequences

- New `sessions.compactedSummary`/`sessions.compactedThroughMessageId`
  columns (migration); every existing row starts null — no Session has ever
  been compacted.
- `pi.ts` gains a narrow single-method `Models` shim (`summarizationModels`)
  alongside the bare `streamSimple` function it already passes to `Agent` —
  used only by the compaction path.
- A Session that never gets long enough to cross the threshold pays no cost
  beyond the token-estimate comparison already derivable from data `pi.ts`
  tracks.
- Summarization is itself an LLM call — adds latency and cost at whichever
  turn boundary crosses the threshold, the same tradeoff OpenClaw accepts
  for the same mechanism.
- Durable, cross-Session facts should keep going through
  `update_repo_memory` (ADR-0018/0022), not rely on surviving in raw
  conversation history — compaction being lossy over old turns is an
  accepted, matching risk, not a new one.
- Sets up, but does not implement, a follow-up ADR for archiving a
  compacted summary at Session-delete time for the orchestrator to
  reference — this decision's summary generation/persistence shape is meant
  to be reusable there without rework.

## Addendum: sidebar visibility, and a re-check bug this surfaced

The original cut only had compaction itself; the user asked to also
"indicate the current context window size and usage" in the sidebar (where
token usage and session time already show) and warn when compaction is
close. Two additions, both small extensions of the same mechanism above,
not a new architectural decision:

- **New `context_usage` event** (`packages/shared/src/events.ts`), broadcast
  alongside the existing compaction check at every turn's end — `{ tokens,
  contextWindow, reserveTokens }`. `GET /api/sessions/:id` also serves the
  same shape (`contextUsage` field, via a new
  `SessionManager.getContextUsageEstimate`) so a page load or session switch
  shows the last-known number immediately rather than waiting on the next
  turn (unlike `turn_activity`, which does stay blank until its next event —
  context usage is cheap enough to compute on demand that there's no reason
  to accept that gap here). For an idle Session with no live `Agent`, the
  REST path resolves the model via the currently-effective provider/model
  config rather than a captured `PiHandle` value — the same approximation
  `startAgent` would use if the Session resumed right now.
- **Sidebar**: `ContextPanel`'s "Current session" card gets a token-count +
  progress-bar row (mirroring the sidebar's existing rate-limit bars'
  neutral/amber/red thresholds), plus explicit text ("Nearing context limit
  — will compact soon") once usage crosses 80% of the compaction trigger
  point (`contextWindow - reserveTokens`), not 80% of the raw window.

**Bug caught while wiring the REST seed, fixed in the same change:** the
original `checkSessionContext` estimated context usage from dilna's raw
`messages` history on every turn, ignoring any compaction already recorded
on the `sessions` row. After a Session's first compaction, its raw history
keeps growing exactly as before (rows are never deleted), so every
subsequent turn's check would see something close to the original
uncompacted total again — reporting a wrong (too-high) number to the UI and
re-triggering `shouldCompact` on essentially every following turn, even
though the live `Agent`'s actual context was already small. Fixed by having
`checkSessionContext` take the Session's prior compaction as an explicit
parameter and estimate against `buildInitialMessages(history, prior)` (the
same reconstruction a cold start would seed) instead of raw history. A
second-or-later compaction now also passes the prior summary to
`generateSummary` as `previousSummary` (a parameter the function already
supported for exactly this), asking for an *updated* summary covering only
what's newly being folded in, rather than re-summarizing everything before
the new cutoff from scratch each time.
