# Burn findings — the judgment layer over recorded usage

## Context

The Metrics page measures spend well: per-turn `usage_events` rows carry
tokens, cache splits, cost, purpose, and the provider-reported context
occupancy, aggregated into totals, breakdowns, and the context-drift list.
Nothing judges any of it. A Session can sit at 90% of its model's window for
its entire life — paying the depth premium on every prompt-side token,
forcing compactions that re-write the whole context as cache writes — and the
dashboard's response is a complete, accurate set of numbers and no sentence
containing the word "wasted".

Issue #291 filed the first finding (D, session overdepth) as one of a batch
(#291–#296) that all need the same seam: a shared finding shape, one
server-side computation home, a card that renders verdicts rather than
aggregates. Decisions made for D become the contract for every later finding
(tool/skill usage facts #292, burn timeline #293, findings C/M/S #294,
unused skills #295, unused tools #296), so they are recorded here once
instead of relitigated per ticket.

## Decision

1. **The shared shape is `BurnFinding`, and the web computes nothing.**
   `packages/shared/src/usage.ts` defines the finding: a `check` code, a
   severity, Session/Repo attribution, self-contained human-readable
   evidence, and an estimated $ waste. `UsageSummary.burnFindings` carries
   the array on the existing `GET /api/usage` response — computed over the
   same time range as every other slice, so the Metrics range selector
   governs findings too. The web renders the evidence string verbatim; it
   derives only presentation (severity badge tone, the `check` code's
   display label via an exhaustive `Record<BurnCheckCode, …>` map, the
   em dash for a null waste). No client-side recomputation, same
   single-home policy as `cacheHitRate`.

2. **One computation home.** `apps/server/src/sessions/burnFindings.ts`
   owns every finding. `getUsageSummary` calls it; findings are not
   scattered across routes or components. A new finding (ticket) adds a
   member to `BurnCheckCode` and a function here — and the web's label map
   fails to typecheck until the new code is named.

3. **Finding D — session overdepth.** A Session whose *median*
   provider-reported context occupancy sits at or past 70% of its catalog
   Model's window (`OVERDEPTH_THRESHOLD`) is flagged; at or past 85%
   (`OVERDEPTH_CRITICAL_THRESHOLD`) it escalates to critical, since
   compaction fires around 92% (window minus reserve tokens) and is either
   running or imminent there. The verdict rests on at least 3 comparable
   turns — provider-reported occupancy against a Model still in the
   catalog — because one deep turn is a one-off (a big paste, a long read),
   not persistence. Judge calls (ADR-0046) are excluded (see 6). The
   ticket batch's letter names map to check codes: D = `session-overdepth`;
   later tickets name their own codes the same way, so a finding row in
   code is always greppable back to its ticket.

4. **Waste is the depth premium over the Session's normal turns.** Each
   deep turn's recorded `costUsd` minus the median cost of the Session's
   turns that are *not* flagged deep (shallow comparable turns and rows
   predating the provider stamp), floored at zero. The baseline excludes
   the penalized turns deliberately: with them in the median, a Session
   whose turns are mostly deep drags its own baseline up and understates
   the premium — the estimator can't be an accomplice of what it estimates.
   When *every* turn is deep, the Session's data offers no cheaper baseline,
   so its overall median is the only honest denominator left. There is no
   invented denominator (no "should have stayed under X%") and no allowance
   percentage: the Session is only ever compared to itself.

5. **A model with no price in the catalog yields a finding without a $
   figure.** Custom-provider models are built with an all-zero cost and
   out-of-catalog ids resolve to nothing; for those, `wasteUsd` is `null` —
   never a computed 0, which would read as "free" rather than
   "unmeasurable" (the same empty-slice policy as `cacheHitRate: null`).
   One unmeasurable turn poisons a Session's baseline and premiums alike,
   so a single such turn downgrades the whole finding to `null`. The
   evidence text says the figure is missing and why, and the web renders
   "—" with a tooltip. Ordering treats `null` as below every priced figure.

6. **Judge calls are excluded from burn findings, without contradicting
   ADR-0046.** ADR-0046 rules judge spend counts toward every dashboard
   aggregate — it is real spend on a real model — and it still does: the
   totals, breakdowns, and daily charts include it exactly as before.
   Burn findings are a different kind of statement: they attribute *a
   Session's own work* to *that Session's decisions* (sitting too deep,
   re-writing cache, overthinking). A judge call runs on its own fresh
   context, so its occupancy says nothing about the Session it scored, and
   folding it into the scored Session's depth would fabricate exactly the
   misattribution this layer exists to avoid. The judge-vs-scored
   comparison that finding S (#294) needs reads judge rows directly, where
   that comparison *is* the question. If a later finding wants to flag
   expensive judging as such, it gets its own check code rather than
   bleeding into D.

## Consequences

- The Burn checks card exists on Metrics: findings worst-first (largest
  estimated waste, then deepest median occupancy; capped like the
  top-spend and drift lists), severity badges, evidence verbatim, and an
  explicit all-clear empty state — an absence of findings is a verdict,
  not "no data".
- Sessions deleted after their turns remain findable (usage_events outlives
  deletion); titles resolve against the archive, and evidence simply omits
  the compaction sentence the archive cannot corroborate.
- The 70%/85% thresholds are exported constants with tests at the exact
  boundary; they are priors like ADR-0048's charsPerToken values and are
  expected to move once real instances accumulate findings. The waste
  model's all-deep fallback makes the premium conservative rather than
  speculative in the pathological case.
- The USD/token formatters the evidence text needs moved to
  `packages/shared/src/format.ts` (previously duplicated between the
  server's evidence strings and the web's dashboard), so the two agree by
  construction.

## Alternatives considered

- **A separate findings endpoint and poll.** More moving parts for the same
  data, and the card would desync from the range selector the summary
  already serves. Findings ride the summary.
- **Client-side computation from raw per-turn rows.** Would ship the
  `usage_events` query surface to the browser and duplicate the thresholds
  and pricing rules in TypeScript on the web side — the exact drift the
  single-home policy exists to prevent, and it would put the model catalog
  behind the web's reach.
- **Mean depth instead of median.** A single pathological turn (an enormous
  paste) would flag an otherwise-shallow Session; the median is the
  persistence test the ticket actually asks for ("sits persistently deep").
- **Baseline = the Session's cheapest turn / a fixed allowance.** Both
  invent a denominator: the cheapest turn makes one lucky cached turn
  punish everything above it, and an allowance encodes a policy number
  nowhere evidenced in the Session's own data. The normal-turn median keeps
  the comparison internal and auditable from the row set.
- **Including judge calls in depth (ADR-0046 maximalism).** Rejected in 6
  above: it would attribute a fresh-context call's occupancy to the Session
  it scored, manufacturing the exact misattribution burn findings exist to
  avoid.
