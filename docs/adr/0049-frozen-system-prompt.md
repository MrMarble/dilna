# Freeze the Session system prompt at first start

## Context

A Session's system prompt is the first message on the wire. On providers
with prefix caching, whatever prefix it forms with the conversation head is
the cache anchor: change one byte of it and every later turn re-pays the
whole prefix as cache writes instead of reading.

Dilna rebuilt the prompt from live state at **every** spawn — and a Session
spawns many times over its life (first turn, post-idle-kill respawn,
post-server-restart, post-compaction). Two pieces of live state fed that
rebuild:

- `formatSkillsPrompt(repoSkills)` — enabling or installing a Repo skill
  mid-session changed the prompt at the next cold start.
- `hasCodegraph` — the worktree's `.codegraph/` presence, which can flip
  relative to the first spawn (the index build is best-effort and races the
  first turn), toggled a whole prompt section.

(The issue that commissioned this ADR, #271, named the Session **title** as
the embedded drift source. That premise is stale: the title left the prompt
in an earlier refactor — `git log -S title -- apps/server/src/agents/pi.ts`
shows the derivation work never touched prompt assembly — and the title is
already purely a UI concern, which is where the issue wanted it. The freeze
below covers title changes for free, since *nothing* re-derives the prompt
anymore; the real drift sources it removes are the two above. #271's
baseline measurement demonstrates exactly this: a skill enabled mid-session
produced three consecutive write-dominant turns, and the freeze removes it.)

Issue #271's acceptance test ("a cold start with a title change in between
asserts byte-identical prompts") is kept verbatim: it now guards against
someone re-embedding the title or any other per-spawn state in the prompt
head — a regression that would previously have been invisible until the
cache bill said so.

## Decision

**The system prompt is assembled once, at the Session's first spawn, and
never re-derived.**

- `sessions` gains a `system_prompt` column (internal to the server; absent
  from `SessionView`, like the compaction fields).
- The first spawn assembles the prompt exactly as before, and
  `SessionManager.startAgent` persists the handle's `PiHandle.systemPrompt`
  onto the row.
- Every later spawn passes `frozenSystemPrompt` in `PiStartOptions`;
  `startPi` uses those bytes verbatim and skips prompt assembly. Skills are
  still resolved (the `read_skill` tool needs them) and the codegraph check
  still runs (the `codegraph` tool still registers) — they just no longer
  rewrite the prompt head.
- If the prompt genuinely needs new context later, the mechanism is to
  **append to the tail**, never rewrite the head, so a cache breakpoint on
  the earlier block survives. Nothing today appends; this is the sanctioned
  extension point.

Pre-existing rows have `system_prompt = null`; their first post-freeze
spawn freezes whatever the then-current assembly produces (exactly the
prompt they were already going to get), and from then on it is stable.
The column is nullable with no backfill — there is no recoverable "prompt
at creation" for a Session that already ran, and fabricating one would be
worse than freezing late.

## Consequences

- A cold start after any prompt-relevant state change (skill enabled,
  index appeared) replays the original bytes; the provider's cached prefix
  survives. #271's measured scenario (skill enabled between restarts)
  flips from re-paying the whole prefix on every cold start to reading it.
- A skill enabled mid-session reaches the model's prompt **at the Session's
  next Session, not this one** — the skill's body is still reachable
  immediately through the `read_skill` tool, and new Sessions pick the
  skill up in their first-spawn prompt. This is the intended trade:
  prompt stability is worth more than mid-Session prompt updates, per
  #271's "the win is bounded rather than dramatic, but it is free".
- The compaction estimate (`estimateFor`) deliberately still measures the
  *unfrozen* rebuilt history; the prompt head is a constant term there, and
  freezing does not change its size.

## Alternatives considered

- **Freeze in the prompt file/agent transcript rather than the DB.** pi
  keeps no external transcript (ADR-0020), so there is nothing to resume
  from — the DB row is the only durable home, and it rides the migration
  machinery every other session-lifetime field uses.
- **Persist a hash and verify instead of the bytes.** Verification without
  the bytes still needs the assembly to be deterministic across releases
  (it is not — `DILNA_AGENT_CONTEXT` is edited periodically). Storing the
  bytes is the only way to make "byte-identical" true across code changes.
- **Append-only prompt sections instead of a frozen head.** This is the
  sanctioned *future extension* (kept as the escape hatch in the decision),
  not the default: nothing today needs to add prompt content mid-Session,
  and building the append machinery now would be mechanism without a
  user.
