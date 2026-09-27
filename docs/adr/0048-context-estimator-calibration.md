# Per-provider calibration of the context estimator, and drift as a first-class signal

## Context

Dilna's own context estimator (the Context meter, the compaction trigger, the
`estimated_context_tokens` stamp) descends from pi-agent-core's
`estimateTokens`: every message costs `Math.ceil(chars / 4)`, regardless of
what it holds. Real Session content is not uniform prose — tool outputs are
JSON, logs are dense, base64 is worse — and the four allowlisted providers
(anthropic, deepseek, moonshotai, zai) each run a BPE tokenizer trained on a
different mix, so the same characters cost a different number of real tokens
per provider. The error is not symmetric in its consequences:

- **Under-counting** (estimating below the provider's real occupancy) means
  compaction fires too late and the real context window overflows — a
  provider error mid-turn.
- **Over-counting** means compaction fires early and throws away context
  that did not need throwing away.

Issue #267 made the provider's own count a first-class column
(`usage_events.provider_context_tokens`); issue #269 made the estimator
measure the live Agent's transcript; this ADR closes the loop: calibrate the
one constant the estimator has, per provider, and surface drift between
estimate and ground truth as a signal rather than leaving it as an argument.

## Decision

1. **One scalar per provider, in the allowlist module.**
   `PROVIDER_CHARS_PER_TOKEN` (`agents/providerConfig.ts`) maps each
   allowlisted provider to a `charsPerToken`; `charsPerTokenFor(provider)`
   falls back to the library's flat `4` for anything else (custom providers,
   unknown ids) — i.e. exactly today's behavior. The estimator's heuristic
   portions (the all-estimate cold path, the trailing tail behind a provider
   report, the compaction cut-point budget) rescale by `4 / charsPerToken`;
   the provider-reported portion of a grounded estimate is never touched.

2. **The measurement is code, not folklore.** `sessions/charCalibration.ts`
   computes the least-squares constant through the proportional family from
   real turns —
   `c* = c_shipped · Σ est² / Σ (est · rep)` —
   where `est` is dilna's stamped `estimated_context_tokens` and `rep` the
   provider's `provider_context_tokens` for the same turn (both stamps land
   in `accumulateSessionUsage`). `scripts/measure-chars-per-token.ts` runs it
   against a deployed instance's DB and prints the recomputed constants
   alongside the mean signed drift per provider. Pasting a converged result
   back into `PROVIDER_CHARS_PER_TOKEN` is the whole recalibration.

3. **The shipped constants are labelled priors, and the instrument to
   replace them ships with them.** This ADR is being written at the same
   commit as the stamps it reads (#267/#270), so no deployed instance has
   accumulated comparable turns yet — that is a fact about sequencing, not a
   reason to ship the mechanism uncalibrated. The initial values
   (anthropic 3.8, deepseek 3.5, moonshotai 3.7, zai 3.6) encode the one
   defensible prior: all four tokenizers are trained on code-heavy,
   multilingual corpora and pack denser than plain-English `chars/4`, and
   denser (a *smaller* constant) is the safe direction of error. They are
   expected to move once the script runs over real data; the drift signal
   below exists precisely so a wrong prior is visible instead of silent.

4. **Drift is visible per turn and per Session, without raw SQL.**
   `accumulateSessionUsage` stamps both numbers on the same row and logs a
   warning when the signed drift `(est − rep) / rep` crosses
   `CONTEXT_DRIFT_THRESHOLD` (25%); `getUsageSummary` aggregates per Session
   into `contextDrift` (mean signed drift, turn count, worst first, capped),
   which the Metrics page renders as its own card. A Session whose estimate
   has drifted past the threshold is therefore identifiable from the dashboard
   or the server log — a query, not an investigation.

5. **The drift deliberately measures the estimator the user experiences.**
   The stamped estimate is the same messages-only heuristic the cold-path
   meter runs — it excludes the system prompt and tool schemas the provider
   counts. That gap is part of the signal: it shows up as a consistent
   positive-offset component in the drift, shrinking proportionally as real
   context grows, and it is called out here rather than hidden by adding
   unaccounted tokens to the meter's figure.

## Consequences

- Compaction timing, the Context meter's cold-path figure, and the
  `keepRecentTokens` cut-point budget all move with the calibrated constant;
  with every shipped value below 4, all of them err slightly toward earlier
  compaction, never toward overflow.
- `usage_events` gains one nullable column (`estimated_context_tokens`), no
  backfill: pre-existing rows carry no dilna-side estimate to stamp, and
  `null` is never read as zero (both stamps must be present for a turn to be
  comparable).
- The per-turn stamp is computed from the live Agent's transcript at turn
  end — the same array `getContextUsageEstimate`'s live path measures, minus
  the trailing in-flight prompt exclusion is irrelevant here since the turn
  has completed.
- Recalibration is a one-file map edit plus a re-run of the script; no schema
  or API change.

## Alternatives considered

- **A real tokenizer per provider.** Precise, but each provider's tokenizer
  is either proprietary or a heavy wasm dependency, and the estimator's job
  is a budgeting heuristic, not billing. A single calibrated scalar keeps the
  estimator pure and synchronous (no Agent, no LLM, no network — the issue's
  own test criterion).
- **Per-model constants.** The model catalog already distinguishes models,
  but content mix dominates model differences within one provider's
  tokenizer; per-provider keeps the calibration surface at the size of the
  allowlist and the measurement honest (a provider's turns pool across its
  models). If the script later shows within-provider spread worth chasing,
  the map can be keyed per model without touching the call sites — it is
  read through `charsPerTokenFor` alone.
- **Calibrating in the database (SQL view) instead of shipping a script.**
  The drift *aggregates* are served that way (`getContextDrift`), but the
  recalibration itself is an offline developer action over a deployed
  instance, not a runtime path — a script is the honest shape.
- **Silent auto-recalibration at runtime.** Tempting once enough turns
  accumulate, but a self-modifying constant would make the estimator
  non-reproducible across instances and un-reviewable; the drift card plus
  the script keep a human in the loop at the one point where judgment
  (enough data? stable mix?) actually matters.
