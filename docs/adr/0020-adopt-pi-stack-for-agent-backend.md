# Replace claude-agent-sdk with a pi-ai/pi-agent-core agent core

> **Supersedes ADR-0019.** That ADR's no-go stands as an accurate record of
> what it evaluated at the time; this ADR is a fresh evaluation of the same
> candidate stack that reaches a different conclusion on finding #1 and
> reweighs findings #2 and #3. It does not reopen map
> [#87](https://github.com/MrMarble/dilna/issues/87), which stays closed.

## Context

ADR-0019 evaluated the `@earendil-works/pi-ai` + `pi-agent-core` +
`pi-coding-agent` + `@anthropic-ai/sandbox-runtime` stack as a
provider-agnostic replacement for `@anthropic-ai/claude-agent-sdk` and
rejected it, citing three findings against the installed 0.84.2 build:
Anthropic usage regressing to third-party OAuth billing, no worktree
confinement in the `read`/`edit`/`write` tools, and no working
persistence/resume path in `pi-agent-core`'s own harness.

Wayfinder map [#93](https://github.com/MrMarble/dilna/issues/93) reopened
the question. Its chartering conversation reached a go decision on narrower
terms than ADR-0019 evaluated: **API-key auth instead of OAuth** (sidestepping
finding #1 entirely rather than accepting it), and findings #2 and #3 accepted
as real gaps to be built around in dilna's own adapter rather than treated as
disqualifying. This ADR records that decision and re-verifies each finding
against the currently installed build (`pi-ai`/`pi-agent-core`/`pi-coding-agent`
0.84.3, one patch ahead of ADR-0019's 0.84.2 — no behavior relevant to any of
the three findings changed between them).

## Decision

**Replace `@anthropic-ai/claude-agent-sdk` entirely** with a new
`apps/server/src/agents/pi.ts` adapter built on `pi-ai` + `pi-agent-core`.
Full replacement, not hybrid (see "Why not hybrid" below). `claude.ts` and its
tests are deleted as part of this plan's execution — not part of this map,
which produces the spec only (see map #93's Notes).

- **Auth: Anthropic API key, not OAuth.** dilna configures `pi.ts` with a
  plain `ANTHROPIC_API_KEY`, never a `claude.ai` OAuth session. OAuth support
  is dropped entirely, for every provider, not just worked around for
  Anthropic.
- **Multi-provider is first-class**, not speculative capacity: DeepSeek, Kimi
  K2, and GLM-4.7 are supported from v1, each via `pi-ai`'s native
  per-provider API-key env vars — confirmed directly against the installed
  0.84.3 catalog (`getBuiltinProviders()`/`getApiKeyEnvVars()` in
  `pi-ai/dist/env-api-keys.js`), **correcting this ADR's earlier text**:
  DeepSeek is `DEEPSEEK_API_KEY` as expected, but Kimi K2's models live under
  the `moonshotai` provider (`MOONSHOT_API_KEY`) — a *different* provider
  from `kimi-coding` (`KIMI_API_KEY`), whose model catalog (`k3`,
  `kimi-for-coding`, ...) doesn't include anything named `kimi-k2-*`. GLM-4.7
  is confirmed under `zai` (`ZAI_API_KEY`), not `zai-coding-cn`. dilna adds
  only its own provider/model *selector* env vars on top (design: ticket
  [#98](https://github.com/MrMarble/dilna/issues/98)); it does no credential
  plumbing of its own.
- **No provider/model picker UI in v1.** Selection is one global env-var pair
  for the whole dilna instance, not a per-session choice. A picker UI is out
  of scope for this map (see map #93's Out of scope).
- **No migration for existing `agentType='claude'` session rows.** This is a
  normal schema migration (design: ticket
  [#99](https://github.com/MrMarble/dilna/issues/99)), not a data-preserving
  one — "claude never existed" for rows that predate this change.

### Finding #1 (OAuth billing): resolved by not using OAuth

ADR-0019 found that `pi-ai`'s Anthropic OAuth registers its own third-party
`client_id`, billing every request through the `claude.ai` "extra usage" pool
instead of the Claude Pro/Max plan's included quota, with no config to change
it. That finding is specifically about the **OAuth** auth path
(`auth.oauth`); it doesn't apply to the separate **API-key** path
(`auth.apiKey`) the same client supports.

Verified against the installed 0.84.3 build:

- `pi-ai/dist/providers/anthropic.js` resolves credentials to one of two
  distinct `auth` shapes depending on how the provider is configured —
  `{ auth: { apiKey } }` (from a stored credential or an env var like
  `ANTHROPIC_API_KEY`) or `{ auth: { oauth } }`. ADR-0019's finding is about
  the latter path; dilna will only ever configure the former.
- `pi-ai/dist/api/anthropic-messages.js` gates OAuth-specific behavior
  (`isOAuthToken`) on the token's own format: `apiKey.includes("sk-ant-oat")`.
  A real Anthropic API key (`sk-ant-api...`) fails that check, so a request
  made with one takes the plain API-key path through Anthropic's Messages
  API — standard per-token API billing, the same path `claude-agent-sdk`
  itself falls back to when no OAuth session is present (ADR-0005's
  host-passthrough credential model already assumes this is a supported,
  normal way to authenticate).

Net effect: using an API key instead of an OAuth session with `pi-ai` doesn't
work around ADR-0019's billing problem, it exits the code path the problem
lives in. This does give up drawing usage from an existing Claude Pro/Max
plan's included quota (`claude-agent-sdk`'s OAuth path could do that; a
straight API key cannot) — accepted as the cost of first-class multi-provider
support, which needs API-key auth uniformly across providers anyway.

### Finding #2 (read/edit/write confinement): still true, ruled buildable-around

Still accurate against 0.84.3: `pi-coding-agent`'s `read`/`edit`/`write` tools
have no worktree containment, and pi's own docs call that permanent,
intentional design. Unlike finding #1, nothing about "which credentials we
use" changes this — it has to be solved in dilna's own adapter. The concrete
design (wrap the existing tools' `execute()` with a containment check vs.
reimplement them against dilna's worktree boundary directly) is ticket
[#95](https://github.com/MrMarble/dilna/issues/95), not decided by this ADR.

### Finding #3 (persistence stub): still true, ruled buildable-around

Still accurate against 0.84.3: `pi-agent-core`'s `AgentHarness` rejects every
state-mutating operation as unimplemented; the only working persistence path
belongs to `pi-coding-agent`'s own hand-rolled `SessionManager`, which
aggregates the bare `Agent`'s live event stream into JSONL — the pattern
ADR-0006 already rejected twice for opencode and Claude. dilna doesn't adopt
that pattern here either: the concrete design for bridging pi's event stream
into dilna's own `Message`/`MessagePart` shape without aggregating live
events as the source of truth is ticket
[#96](https://github.com/MrMarble/dilna/issues/96).

## Why not hybrid

Keep `claude-agent-sdk` for Anthropic and add `pi.ts` only for other
providers was considered and rejected, same as in ADR-0019. ADR-0019's reason
for rejecting hybrid (findings #2 and #3 are properties of the pi stack
itself, not specific to any one provider — a `pi.ts` adapter for DeepSeek
alone would still need the confinement and persistence work) still holds
unchanged. What's different this time is the premise ADR-0019 weighed hybrid
against: multi-provider support was speculative capacity then ("no concrete
provider requirement exists today"); this map's chartering makes it a first-class,
committed requirement instead. A commitment to real multi-provider support
removes the case for keeping two adapters around — there's no longer a
"one active provider, why pay for the second adapter" tension (the same shape
of reasoning ADR-0011 used to drop opencode) once more than one provider is
actually being used.

## Consequences

- Map [#87](https://github.com/MrMarble/dilna/issues/87) and ADR-0019 are
  unchanged and stay closed; they're the historical record of the OAuth-based
  evaluation, not superseded findings to edit.
- `apps/server/src/agents/claude.ts`, its tests, and the
  `@anthropic-ai/claude-agent-sdk` dependency are deleted — execution work,
  tracked outside this map (map #93 produces the spec, not the code; see its
  Notes).
- The concrete designs this decision depends on are not yet written: read/edit/write
  confinement (ticket #95), the persistence bridge (ticket #96), the
  `SessionManager` dispatch swap from `claude.ts` to `pi.ts` (ticket
  [#97](https://github.com/MrMarble/dilna/issues/97)), the env-var
  provider/model config contract (ticket #98), and the `Session.agentType`
  schema migration (ticket #99). This ADR authorizes the direction; those
  tickets are where it becomes buildable.
- **ADR-0014's crash-recovery guarantee regresses, accepted deliberately.**
  Claude's boot recovery (`resetAllToIdle`/`backfillFromTranscript`) reads a
  transcript file the CLI subprocess writes independently of dilna's own
  process — a dilna server crash mid-turn can still recover the agent's
  response from it. `pi-agent-core`'s `Agent` runs in-process, with no
  independent durable copy of its own; a dilna server crash mid-turn loses
  that turn's assistant output and tool calls (the user's own message
  survives — `beginTurn`'s pending-placeholder promotion doesn't depend on
  the agent at all). The *code changes themselves* aren't at risk — worktree
  writes (edits, commits) are real, already-flushed filesystem/git state,
  independent of dilna's SQLite or pi's in-memory transcript either way; what's
  lost is the chat-visible record of that one interrupted turn. Incremental
  persistence (writing on every `message_end` instead of batching at
  `agent_end`) was considered and rejected as not actually closing the gap:
  since pi has no subprocess of its own, a crash could still land mid-way
  through the message that would have been the *next* `message_end` — it
  narrows the loss window, it doesn't restore Claude's independent-process
  guarantee, and it adds real write volume/complexity for a rare failure
  mode (a server crash specifically mid-turn, not a resumable idle-kill or
  clean restart). Accepted as a known, named limitation — matching this
  migration's bare-minimum-now bias elsewhere (see [#101](https://github.com/MrMarble/dilna/issues/101)'s
  identical resolution for the background-work/subagent/cron gap) — not
  silently dropped.
- `docs/research/pi-agent-harness.md` (branch `research/pi-agent-harness`)
  and the spike at `/home/atm/Documents/repos/pi-sandbox-spike` (branch
  `main`, commit `f9c1d4a`, local only) remain the primary sources behind
  both this ADR and ADR-0019's findings.
- `CONTEXT.md`'s **Agent** entry and its ADR pointer are updated in the same
  change as this ADR (see the CONTEXT.md diff); **Provider** and **Model**
  are added as new terms, splitting what "backend" used to mean ambiguously
  (which Agent implementation vs. which LLM vendor) into two distinct
  concepts. The Agent entry still describes `claude.ts` as what's actually
  running until the execution work lands — this map produces the spec only.
