# Idle-kill defers to the SDK's own background-work/wakeup signal

## Context

`SessionManager` idle-kills the resident Claude CLI process 5 minutes after
a turn ends (`IDLE_TIMEOUT_MS`, ADR-0003), tracked purely by dilna's own
turn state (`turnsInProgress`). The Claude Agent SDK, independently, lets
the agent register work that's meant to outlive a single turn: a
`run_in_background` shell job, and `ScheduleWakeup`/`CronCreate`/`/loop`
session-cron registrations that re-inject a prompt into the *same* resident
process later. Neither is visible to `SessionManager` — the SDK's process
model (ADR-0007) keeps one subprocess alive across turns via streaming
input, but dilna's idle timer arms unconditionally at every turn end,
oblivious to whether the agent just told the user "I'll check back in 20
minutes" and registered a wakeup to do it.

Symptom: a turn ends, the agent has a `ScheduleWakeup` pending or a
background shell job still running, the 5-minute timer fires before either
completes, and `stop()` kills the subprocess — taking the background job
and the wakeup registration down with it (ADR-0014: the child dies with the
parent). The wakeup, when it does fire against the by-then-dead process,
surfaces only as an ambiguous "no completion record found... may have been
stopped, or the process may have exited" — indistinguishable, from the
outside, from the process having genuinely finished. There is no
`SDKMessage` push event for a cron-registration existing or clearing, so
`SessionManager` can't infer this from the message stream it already
consumes (`docs/research/claude-agent-sdk-in-turn-signals.md` §3, §6 — the
closest thing, `background_tasks_changed`, only covers *running* work, not
scheduled-for-later work).

A second-order consequence: a `ScheduleWakeup` firing autonomously starts a
new response inside the same resident process without ever going through
`chatClaude`, so it never touches `SessionManager`'s own turn-tracking
either. If the idle timer isn't already suppressed, it can fire *during*
that autonomous response just as easily as during the gap before it.

## Decision

Consume the SDK's `Stop` hook (`options.hooks.Stop`, registered in
`startClaude`). It's the one point in the SDK where `session_crons` (cron/
wakeup registrations) is exposed at all, alongside `background_tasks`
(running/pending/backgrounded work) — see `StopHookInput` in the SDK's type
declarations. Critically, it fires once per response *regardless of what
triggered that response*, including an autonomous cron-fired one, so it
doubles as a turn-end signal `SessionManager` wouldn't otherwise see for
that case.

`hasPendingBackgroundWork(input)` (`agents/claude.ts`) classifies a
`StopHookInput` as pending work if either array is non-empty. The hook
callback reports this via a new `onPendingWorkChanged` option on
`ClaudeStartOptions`, mirroring the existing `onInit`/`onRateLimit`
side-channel pattern (rate limits and the session id aren't `AgentStreamEvent`
material either, for the same reason: adapter-internal state, not
subscriber-facing chat content).

`SessionManager` tracks the latest snapshot per session
(`ActiveAgent.hasPendingBackgroundWork`) and:

- `armIdleTimer` is a no-op while it's `true` — every existing call site
  (normal turn end, stop-timeout escalation, `failTurn`'s non-crashy path)
  goes through this one function, so no call site needed touching.
- `idleKill` re-checks the flag defensively before killing, in case a timer
  armed just before the hook cleared it — the hook and the turn-end path
  that calls `armIdleTimer` race each other, and this makes the outcome
  correct regardless of which lands first.
- `handlePendingWorkChanged` (the hook's landing spot) is also the only
  place that can *re-arm* the timer once pending work clears and dilna
  itself isn't mid-turn (`!turnsInProgress.has(id)`) — necessary for the
  autonomous-cron-response case above, since nothing else in
  `SessionManager` learns that response happened at all.

The hook callback itself is a pure observer: it returns `{}` (every
`SyncHookJSONOutput` field is optional), so registering it doesn't change
whether or how a turn stops — only what dilna learns about it.

## Why the `Stop` hook over `background_tasks_changed`

`background_tasks_changed` is a live push event already flowing through
`startClaude`'s persistent message loop, and covers the "background shell
job" half of the problem on its own. It does **not** cover
`session_crons` — there is no push event for a wakeup/cron registration
existing, firing, or clearing; `session_crons` is only ever handed to
`StopHookInput`/`SubagentStopHookInput`. Since the wakeup case is the one
this ADR exists to fix, `background_tasks_changed` alone doesn't solve it,
and the `Stop` hook's snapshot already includes both arrays in one place at
exactly the moment `SessionManager` needs to decide whether to arm the
timer — using it for both avoids carrying two independent signals that
would need reconciling against each other.

## Why observe-only instead of using the hook's `decision`/`additionalContext` to keep the turn going

`SyncHookJSONOutput.decision: 'block'` on a `Stop` hook can force the agent
to keep responding instead of stopping. Deliberately unused here: the goal
is to keep the *process* alive for work already in flight, not to compel
the *model* to keep talking. Blocking every stop while background work
exists would fight the agent's own judgment about when to actually stop
responding, and turns "don't idle-kill" into "never let this turn end,"
which is a different (and worse) behavior than intended.

## Consequences

- A session with a live `ScheduleWakeup` or a running background shell job
  stays resident past the 5-minute idle window for as long as that work is
  outstanding — by design; the resident-process footprint (ADR-0003) grows
  for sessions that use these features, bounded by however long the agent's
  own registered work runs.
- A cron/wakeup registration that itself schedules further work (a
  recurring `/loop`) keeps the session alive indefinitely, same as if a
  human kept sending messages — expected, since a recurring registration is
  the agent equivalent of a human staying in the chat.
- No change to explicit stops: the manual Stop button and crash handling
  (`stopSession`/`markCrashed`) are untouched — this only gates the
  *automatic* idle-kill path, since those two are already deliberate action
  regardless of outstanding work.
- `docs/research/claude-agent-sdk-in-turn-signals.md` predates this
  decision and doesn't mention `session_crons`/the `Stop` hook (its scope
  was in-turn feedback signals, not turn-end/process-lifecycle ones) — not
  updated here since it's a point-in-time research artifact, not a living
  spec.
