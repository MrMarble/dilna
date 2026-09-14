# Read-only subagent `task` tool: in-turn delegation with an isolated context

## Context

An ordinary Session's Agent has exactly one context and one thread of
execution. Everything it does — reading twelve files to locate a call site,
grepping four ways to find a pattern's real usages — lands in that single
context and stays there for the rest of the Session. Two costs follow: the
turn is serial even when the work is embarrassingly parallel, and exploratory
reading permanently occupies context that later reasoning needs. ADR-0023's
compaction reclaims that space *after* the fact; nothing avoids spending it.

dilna already has a fan-out mechanism, and it is deliberately not this one.
The orchestrator (ADR-0021/0025) is a *user-facing meta-chat* that spawns
independent Sessions via `dilna_create_session`, each with its own Worktree
and branch. That call is fire-and-forget by design (ADR-0021 decision 4): a
spawned Session never reports back into the caller's conversation. So the
orchestrator cannot express "go find this out and tell me, now, so I can use
the answer in this turn" — no amount of polishing it would, because the
missing piece is a *return value*, not better ergonomics.

[Issue #206](https://github.com/MrMarble/dilna/issues/206) asks for the other
shape: a tool the Agent itself calls mid-turn, which runs a scoped
investigation in a fresh context and returns its answer as an ordinary tool
result.

Prior research settles the mechanism.
[Issue #101](https://github.com/MrMarble/dilna/issues/101)
(`docs/research/pi-extensions-background-work.md`, on the unmerged
`origin/research/pi-extensions-background-work` branch) confirmed three
independent ways that pi ships no subagent feature: its own official example
implements one by spawning a fresh `pi` CLI subprocess in JSON mode (~600
lines), and OpenClaw built its own at the host-application layer. That
research also called dilna's path cheaper than either: `pi.ts` already
constructs bare `pi-agent-core` `Agent` instances, so a subagent here is
"construct one more `Agent`, in-process" — no subprocess, no
`pi-coding-agent` product layer, no `ExtensionAPI`.

## Decision

**A new `task` tool, registered only for ordinary Sessions** (`startPi`'s tool
array), whose `execute()` constructs a second bare `Agent`, awaits one
`.prompt()`, and returns the final assistant text as the tool result.

### Read-only, enforced by tool omission

The child's tool array is `read`, `grep`, `find`, `ls`, `web_fetch` — no
`write`/`edit`/`bash`, no `dilna_publish_artefact`, no repo-memory write, and
no `task` of its own.

This is the load-bearing constraint, and it follows from one fact: **a
subagent shares its parent's Worktree.** There is no second worktree to
isolate into — that absence is exactly why a subagent is cheaper than a
Session. Concurrent writers on one worktree (two `edit`s racing on a file,
a `bash` running `git checkout` under another's feet) is data loss, not a
subtle race, and dilna has no locking layer to arbitrate it. Read-only makes
parallel fan-out trivially safe instead of requiring one to be invented.

Enforcement is by *which tools exist*, not by permission checks on a fuller
set — the same construction `startOrchestrator` already uses to have no
filesystem tools at all. The confinement hook (`createConfinementHook`) is
still installed on the child, so its reads are worktree-bounded exactly like
the parent's; it is a backstop, not the mechanism.

### Cold context, inherited model

The child starts with **no conversation history** — only its `prompt`
parameter and its own system prompt. Inheriting the parent's transcript would
defeat the entire purpose: the point is that 50k tokens of exploration happen
somewhere that isn't the parent's context. The caller is therefore
responsible for writing a self-contained `prompt`, which the tool description
states explicitly.

The child inherits the parent's resolved provider/model, so a Session that
configured a specific model doesn't silently fan out onto a different one.

### Awaited in-call, which is what keeps the lifecycle free

The tool `await`s the child to completion. A subagent therefore **cannot
outlive its parent turn**, and three otherwise-hard problems dissolve:

- **Idle-kill (ADR-0017) needs no changes.** That ADR keeps a Session
  resident while background work is pending, using the Claude SDK's `Stop`
  hook to learn about it. Pi exposes no equivalent signal (#101). Because a
  subagent is always inside an in-flight tool call, the turn is by definition
  still running, and the existing turn-based timer suppression already covers
  it.
- **Crash recovery needs no changes.** There is no detached unit of work that
  could be left marked "running" after a restart — the same reasoning
  ADR-0025 used to reject a `TaskRecord`-style lifecycle table.
- **Parallelism is free.** `pi-agent-core` already executes a turn's tool
  calls concurrently, so N `task` calls in one assistant message fan out with
  no scheduler, queue, or worker pool in dilna.

A per-turn cap bounds blast radius, mirroring
`ORCHESTRATOR_MAX_SESSIONS_PER_TURN` (ADR-0021 decision 3): the call errors
past the cap rather than dilna silently dropping it.

### UI: repopulate `turn_activity.tasks`, which already exists

`turn_activity.tasks[]` has been in the shared event union since ADR-0016 §5
(`packages/shared/src/events.ts`), carrying `taskId`, `description`,
`lastTool`, `toolUses`, `startedAt`, `toolUseId`. It is a vestige of the
Claude-SDK Task tool, and since the ADR-0020 backend swap nothing has emitted
it — the field has been permanently empty, while `SessionBroadcaster`'s
retention of it and `ChatShell`'s handler for it both remained in place.

So this ADR adds a *producer* for an existing contract rather than extending
the wire format. `AgentStreamEvent` is unchanged. A mid-turn reconnect
already replays the current activity via the ADR-0016 §4 opening snapshot,
with no new code.

The rendering is deliberately minimal: a count ("2 active tasks") on the same
muted single line that already renders `turn_activity.phase` via
`PHASE_LABEL`. The per-task fields are populated on the wire anyway, so a
richer view is a client-only change later.

### Transcript

A subagent's result is an ordinary tool result on an ordinary tool call. It
flows through the existing `tool_call_start`/`tool_call_end` path with no
special case, and `tasks[]` is live-only activity that is never persisted.

A failed or capped subagent returns its explanation as ordinary result *text*
rather than a flagged error. `pi-agent-core` derives a tool result's error
flag solely from whether `execute()` threw — `executeTool` hardcodes
`isError: false` on the success path, and `finalizeExecutedToolCall` carries
only `content`/`details`/`usage`/`terminate` forward from a returned result,
so a returned `isError` is silently dropped. Throwing instead would fail the
parent's whole turn, which is the wrong outcome for a subagent the parent can
trivially route around by doing the work itself. (Noted in passing:
`artefactTools.ts` returns `isError: true` on a rejected publish, which is
dead for the same reason — its message text is what actually reaches the
model. Harmless there, and left alone as out of scope here.)

This is a direct response to [issue #78](https://github.com/MrMarble/dilna/issues/78),
where the Claude backend's background-task completions arrived as synthetic
user-role messages and were persisted as garbled `role: "user"` rows full of
raw `<task-notification>` XML. The defect there was that completion arrived
*outside* the tool-call protocol. Keeping the result inside it is what
prevents a recurrence.

## Why not the alternatives

- **Extend the orchestrator instead**: rejected — `dilna_create_session` is
  fire-and-forget (ADR-0021 decision 4) and produces a whole Session with its
  own Worktree. The gap is a tool call that *returns a value into the current
  turn*; that is a different mechanism, not a missing option on an existing
  one. Both features stay, addressing different needs.
- **Write-capable subagents in v1**: deferred, not rejected. It requires a
  concurrency story for the shared Worktree (serialize? per-file locks?
  accept the race?) that read-only simply doesn't need. Shipping readers
  first delivers the context-isolation win without inventing a correctness
  model; nothing here forecloses adding writers later.
- **A worktree per subagent** (making writers safe): rejected for v1 — that
  is materially what a spawned Session already is, at which point the
  orchestrator is the right tool. The cheapness of a subagent comes precisely
  from *not* creating a worktree.
- **Spawning a `pi` CLI subprocess**, as pi's own official example does:
  rejected — the example does that only because a CLI extension has no direct
  `Agent` access. `pi.ts` does. A subprocess would add process management,
  JSON-lines parsing, and a `pi`-binary-on-`PATH` dependency for no gain
  (#101).
- **Detached/background tasks outliving the turn**: rejected — it would need
  ADR-0017-shaped infrastructure that pi cannot signal (#101), in exchange
  for a capability nothing has asked for.
- **Nested subagents**: rejected structurally (the child has no `task` tool)
  rather than by a depth counter — recursive fan-out multiplies cost
  unboundedly, and one level covers the motivating use case.
- **A new event type for task activity**: rejected — `turn_activity.tasks`
  already exists with the right fields, is already retained for the reconnect
  snapshot, and is already handled client-side.

## Consequences

- Ordinary Sessions gain a `task` tool; orchestrator Sessions do not (they
  have no filesystem tools to delegate).
- A turn's token spend becomes less predictable: N parallel children each
  consume context against the same provider. The per-turn cap bounds it, and
  child usage is attributed to the Session like any other call.
- `turn_activity` acquires its first producer since the ADR-0020 backend
  swap; `packages/shared` is untouched.
- Subagents are invisible in persisted history beyond the `task` tool call
  and its result — by design, and the #78 regression guard.
- A subagent cannot report partial progress: it returns once, at completion.
  The activity line shows that it is running; the answer arrives whole.
