# Multi-model orchestration: config-row roles, execution-time model choice, subagent cost attribution

## Context

dilna runs every token a Session spends on one model: the instance default
(env or the Settings override), optionally pinned per Session at creation
(#250). Orchestration, read-only exploration through `task` (ADR-0034),
title derivation, compaction summaries (ADR-0023) and the output-scoring
judge (ADR-0046) all go through it. A frontier model is wasted on the
mechanical parts; a cheap one can't carry the whole Session.

[Issue #287](https://github.com/MrMarble/dilna/issues/287) plans the fix in
phases — measure subagent spend, add model roles in Settings, let the two
delegation seams (`dilna_create_session`, `task`) pick a model, and route
the utility calls to a cheap one. Two prior arts shaped it: oh-my-opencode
(a heavy main agent delegating to purpose-pinned subagents on other models)
and ZCode (`zai-org/ZCode`), a production harness with the same shape as
dilna — one runtime, a tool registry, a persistence bridge. ZCode's lessons
are the ones this ADR adopts or deliberately departs from.

This ADR records the decisions the later phases build on. Phase 0
(issue #307) ships with it: until a subagent's spend is measured, no
multi-model setup can show that it saved anything.

## Decision

### 1. Roles are configuration rows; v1 has exactly one, `cheap`

A **model role** is a named slot in Settings that points at one validated
provider/model pair — validated through the same path the Settings override
and per-Session pinning already use (provider known, builtin or custom;
model in its catalog; key resolvable). It is configuration, not provider
machinery: a role adds no new way to reach a model, only a name for a pair
that could already be pinned.

v1 ships one role, `cheap`: the model for work where good-enough beats
perfect (titles, summaries, scoring, bulk exploration). Unset by default,
and an unset role changes nothing — every consumer falls back to what it
does today.

There is one resolver, `role name → validated pair | not configured`, and
every consumer goes through it.

### 2. Model choice resolves at execution time and is never advertised as model ids

Where the parent model can pick a model (the orchestrator's spawn tool, the
`task` tool), it picks a **role name** — a concrete pair is accepted too,
validated like a user pin — and the name resolves to a model when the call
executes, against the then-current Settings.

Tool descriptions and system prompts list role names only, never concrete
model ids. This is ZCode's central lesson: its `Agent` tool has no
per-call `model` argument at all, because historical calls in the
transcript keep their old arguments and the model mimics them after the
user re-points a role, clobbering current config. dilna keeps the
per-call choice (§4) but neutralises the hazard the same way: a role name
in an old call still means "whatever cheap is now", and no id the
model could copy appears anywhere it reads as guidance.

### 3. Subagent spend is real spend, ledgered separately

Each `task` run's usage is summed over every assistant round the child ran
and written as its own `usage_events` row with purpose `"subagent"`:

- **Keyed to the delegation**: the spawning Session's id and the parent's
  `task` tool-call id (`usage_events.tool_call_id`), so a cost is
  attributable to the exact call in the transcript.
- **On the model the child actually ran on**, not the parent's — once the
  child can run on another model (§4) the by-model breakdown must say so.
- **Outside the Session's own `input_tokens`/`output_tokens`**, same
  treatment as judge spend (ADR-0046): a Session's counters describe the
  work its own Agent did. Every Metrics aggregate (totals, daily, by repo,
  by model, by purpose) counts it, because it was billed; the burn timeline
  renders it as a side-call marker, not a turn.
- **Recorded even when the child fails or is stopped**: tokens spent before
  dying were billed. The rows are summed from `message_end` events as they
  happen, not read off the child's final state.

The `task` tool result also carries a one-line usage footer — model,
tokens, cost — so the parent model sees what a delegation cost at the
point where it decides whether to delegate again. ZCode does the same
(`<usage>subagent_tokens…</usage>` on the tool result). This reports a
fact about a finished call, which is different from advertising a choice
in a description (§2).

Utility calls routed to a role later (titles, compaction) follow the same
rule: their own purpose, the model actually used, outside the Session's
counters.

### 4. Amendment to ADR-0034: explicit per-call model choice is allowed

ADR-0034 had the child inherit the parent's resolved model, "so a Session
that configured a specific model doesn't silently fan out onto a different
one". The guarantee that matters is *silent*: the child runs on another
model only when the parent explicitly asked for one on that call. Omitting
the choice still means the parent's model, exactly as before. The per-turn
caps (8 `task` calls, 10 spawned Sessions) are unchanged: a cheaper model
per call lowers the stakes of fan-out, but the accounting in §3 is what
makes it visible, not a reason to raise the cap.

## Why not the alternatives

- **Named profiles (ZCode-style model + prompt + toolset bundles) now.**
  ZCode ended up there after shipping both, and a role is the obvious seed
  of one. But a profile needs the `task` tool's fixed read-only toolset and
  `SUBAGENT_SYSTEM_PROMPT` to become per-call config first, and nothing
  yet shows which purposes are worth a profile. This phase's usage data is
  what decides that; roles migrate into profiles' `model` field without
  changing their meaning.
- **No per-call model argument at all (ZCode's choice).** It removes the
  transcript hazard by removing the feature: the parent could never
  de-escalate one exploration to a cheap model or escalate one design
  question to a strong one. Execution-time resolution plus role names
  addresses the hazard while keeping the choice.
- **Folding subagent spend into the parent turn's row.** Simpler, but it
  loses the child's model (the parent row has one provider/model), so the
  by-model breakdown would credit cheap-model spend to the expensive model —
  the exact number a multi-model setup needs to be right.
- **Adding subagent spend to the Session's own counters.** The Session's
  token badge would then disagree with its own transcript, and judge spend
  already established that side spend stays outside them.

## Consequences

- `UsagePurpose` gains `"subagent"`; `usage_events` gains a nullable
  `tool_call_id`. Every reader that means "the Session's own turns" already
  filters `purpose = 'turn'`, so the per-turn burn checks, tool facts and
  cache readings are unaffected; the burn findings' per-Session spend total
  (the fan-out comparison) now includes subagent rows.
- The web's per-purpose renderings (Total cost card, burn-timeline markers)
  are exhaustive `Record<Exclude<UsagePurpose, "turn">, …>` maps, so the
  next purpose must be named there before it type-checks.
- Later phases of #287 (roles in Settings, the two delegation seams, utility
  routing) implement §1, §2 and §4 against this record; none of them need
  to revisit it unless the usage data argues for profiles.
