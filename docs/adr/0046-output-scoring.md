# Output scoring: an on-demand judge model scores a turn against criteria

## Context

Everything dilna measures today is quantitative: `sessions.input_tokens`/
`output_tokens`, `usage_events` and the Metrics dashboard report cost and
volume, never quality. Issue #251 asks for the missing half: a second model
reads a turn and says how good it was, as a 0..1 score plus a written reason.
It is the sibling of #250 (model comparison), whose columns are the obvious
place a score would eventually sit.

The issue's investigation of `confident-ai/deepeval` (the de facto
open-source eval framework) is the prior art. Its design is worth borrowing.
A metric is `measure(testCase) -> score in 0..1` with a reason, pass/fail is
`score >= threshold`, and a judge metric makes several small, confined model
calls instead of one holistic "rate this 1-10", to cut variance. Its
dependency is not worth taking: the TypeScript port is pre-1.0, posthog
telemetry is on by default, and it is a test framework with no service mode.

dilna already has the right seam. `sessions/context.ts` makes bare,
non-agentic model calls through `agents/pi.ts`'s narrow
`resolveSummarizationModel`/`summarizeMessages` (ADR-0023). A judge call is
the same shape with a different prompt.

## Decision

**Scoring is on demand, per turn.** A Score button on each finished
assistant turn opens a dialog: pick a metric, write criteria (for the
criteria metric), a threshold (default 0.5) and a judge model. Nothing
scores automatically. Every judge call spends tokens, and an opt-in click
keeps that spend predictable. Automatic per-turn judging (#138's "advisor")
and gating a Session on a score are out of scope.

**A score is keyed by `turnId`, not by a message id.** One turn is several
`messages` rows (ADR-0026 §3), and the judge reads the turn as a whole. The
subject is `{ input, actualOutput, toolActivity }`. The input is the nearest
user row before the turn. The output is the turn's text parts. Tool activity
is a truncated list of the turn's tool calls, so criteria like "ran the tests
before claiming success" can be judged. There is no `expectedOutput`, because
dilna has no ground truth for "write the fix", so any metric that needs one
is off the table.

**Two metrics ship, as plain functions in `sessions/scoring.ts`**, dispatched
by a `switch` rather than a registry (ADR-0011):

- `criteria` (G-Eval-shaped), in two calls. First the user's criteria become
  2–5 evaluation steps, derived *without* seeing the reply so the steps can't
  be rationalized from it. Then the reply is scored 0–10 per step. The score
  is the mean over 10.
- `relevancy` (deepeval's answer relevancy), in three calls: split the reply
  into statements, give each a yes/no/idk verdict against the prompt, then
  explain the score. `idk` counts as relevant, as in deepeval. If the reason
  call fails, the metric falls back to a mechanical reason rather than
  discarding verdicts already paid for.

Judge replies are asked for JSON and parsed leniently (the outermost `{…}`).
A judge that returns nothing usable fails the request with 502. It never
produces a fabricated score.

**The judge defaults to the Session's own model and can be any keyed model.**
The dialog pre-selects the Session's provider/model, so the default is cheap
and needs no extra key. Any model of a provider with a configured key can be
picked instead, including a different provider from the one under test. That
is what will make judging #250's comparison columns meaningful. The client
sends a `provider`/`model` override only when the pick differs from the
Session's own, so the server's resolution (Session snapshot, else effective
config) stays the single definition of "the Session's model".

**Judge spend is its own `usage_events` bucket.** `usage_events` gains a
`purpose` column (`"turn"` default, `"judge"`). Each scoring request writes
one `"judge"` row with the summed usage of its calls. The row is written
even when the metric then fails, because the tokens were spent. Judge spend
is real spend, so it counts toward every dashboard aggregate. It is never
added to the Session's own `input_tokens`/`output_tokens`, so a scored
Session's numbers still describe the work it did. `GET /api/usage` returns a
`byPurpose` split, and the Total cost card notes how much went on scoring.

**The one pi-touching call is `judgeComplete`** in `agents/pi.ts`: a system
prompt plus one user prompt through `completeSimple`, using the same
stored-key lookup the summarization shim uses. It returns text plus usage, or
`null` on failure, and never throws. Everything else is policy and lives in
`sessions/scoring.ts`, which reaches the judge through an injectable function
so the metrics are tested with canned replies.

**Persistence:** a `turn_scores` table, append-only (re-scoring a turn adds a
row), no FK, pruned by `SessionManager.delete` like artefacts. API:
`GET /api/sessions/:id/scores` and
`POST /api/sessions/:id/turns/:turnId/scores`. The POST is synchronous and
returns the score. No stream event is sent, because only the tab that asked
is waiting.

## Consequences

- A score request takes several seconds (2–3 sequential model calls). The
  dialog shows "Scoring…" and stays open until the result arrives or fails.
- The same model grading its own output is the default. That is cheap but
  biased toward itself, and the dialog makes the alternative one select
  away.
- Scores are not live state. A second tab doesn't see a new score until it
  reloads. That's acceptable for an opt-in, single-user action. If #250 wants
  scores in comparison headers, the same `GET` serves them.
- Compaction and title-generation calls remain unaccounted, as before.
  `purpose` gives them an obvious home if that changes.

## Alternatives considered

- **Adopt deepeval.** Rejected in #251 itself: pre-1.0 TS port, default-on
  telemetry, and a test-runner workflow that doesn't fit a button pressed on
  an answer the user is already reading.
- **Score automatically at turn end.** It adds surprise latency and cost to
  every turn. It stays possible later behind the same `scoreTurn`.
- **One holistic "rate 1–10" call.** Cheaper, but it is exactly the
  high-variance shape deepeval's multi-call metrics exist to avoid.
- **Fold judge usage into the Session's totals.** That pollutes the
  Session's own numbers. Leaving it unaccounted (as compaction is) would hide
  spend the user explicitly chose to make.
- **Key scores by message id.** A turn's first row is an arbitrary anchor for
  a verdict about the whole turn, and folding (`foldTurnRows`) already treats
  `turnId` as the turn's identity.
