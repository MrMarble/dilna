# Drop the opencode backend; standardize on Claude Agent SDK

## Context

ADR-0002 shipped `OpencodeAgent` as dilna's MVP backend. ADR-0007 added a
second backend, `ClaudeAgent`, behind a `handle.kind` discriminant in
`SessionManager` — the interface was kept intentionally thin rather than a
full abstraction, on the reasoning that a third backend would tell us what
else needed generalizing.

In practice, a third backend never arrived, and opencode itself stopped being
used: dilna's actual day-to-day usage is exclusively through the Claude Agent
SDK backend. Keeping both meant every layer of the stack carried two parallel
implementations for a single active user: event normalization
(`normalizeEvent`/`normalizePartUpdate` in the now-removed `opencode.ts` vs.
`claude.ts`'s SDKMessage handling), transcript-to-`Message` conversion
(`opencodePartToDilna` vs. `claudeMessagesToDilna`), and — most recently —
per-backend sandboxing configuration (ADR-0010's `writablePaths` differ per
backend; opencode additionally needed `allowBindPorts` for its HTTP `serve`
port, which Claude's stdio-based subprocess never needed). None of that
duplication was buying anything: the second backend was speculative capacity
for a multi-backend future that hadn't materialized, at the cost of doubling
maintenance surface in a project run by a single operator.

## Decision

Remove `apps/server/src/agents/opencode.ts` and the `@opencode-ai/sdk`
dependency entirely. `SessionManager` no longer branches on `handle.kind`
anywhere — every code path (`sendMessage`, `persistMessagesFromAgent`,
`maybeSyncTitle`, `ensureStarted`) calls the Claude Agent SDK adapter
directly, and `ActiveAgent.handle` is typed as `ClaudeHandle` rather than a
union.

`AgentType` (in `packages/shared/src/types.ts`) drops `"opencode"` but keeps
`"openai"` as a reserved, not-yet-implemented value — unlike opencode, it was
never built, so it costs nothing beyond the guard clauses that already throw
"not implemented yet" (ADR-0002's original low-cost-foresight reasoning still
holds for that one field). `DEFAULT_AGENT_TYPE` and `Session.agentType`'s
column default both move from `"opencode"` to `"claude"`.

`apps/server/src/agents/sandbox.ts` drops `allowBindPorts` — it existed
solely for opencode's `serve` HTTP port; the Claude Agent SDK subprocess
communicates over stdio and never needed inbound binding.

The web app's `NewSessionDialog` drops its agent picker. A selector with one
functioning option is dead UI, not a feature — CONTEXT.md's `AgentType`
`"openai"` placeholder isn't offered to users until it actually exists.

End-to-end verification of this change (isolated instance, real repo, real
Claude turn) surfaced a pre-existing, unrelated bug: `agents/claude.ts`'s
`writablePaths` never included `~/.claude/projects`, where the CLI writes its
own session transcript. Under sandlock that silently broke persisted message
history and title auto-sync for every Claude session — sandboxed or not,
since Claude is now the only backend. Fixed in the same change (see
ADR-0010's updated writable-paths list) since it directly blocked verifying
this ADR's own change.

## Consequences

- `SessionManager` is simpler: no `handle.kind` branches, no dual transcript
  converters, no dual event normalizers. One code path to read and maintain.
- Docker image and `docker-compose.yml` no longer install or mount opencode
  (`npm install -g opencode-ai`, `~/.config/opencode`, `~/.local/share/opencode`).
- No data migration was needed: no `opencode`-typed sessions existed in local
  dev data at the time of this change. If a deployed instance somewhere still
  has `agentType = 'opencode'` rows, `ensureStarted` will fail resuming them
  (no adapter registered for that value) — acceptable given dilna is
  self-hosted, single-operator software with no external users to coordinate
  a migration for.
- Adding a backend back later (opencode or otherwise) is exactly the
  "one new adapter file + a dispatch branch" story ADR-0002 always described
  — nothing about this change makes that harder, it just stops paying for a
  branch nobody was using.
- ADR-0002 and ADR-0007's adapter-design reasoning (thin interface, why not
  full abstraction, streaming-input mode) still stands for the surviving
  Claude backend; only the multi-backend dispatch and the opencode adapter
  itself are retired. ADR-0009's opencode-specific Docker mount/install
  details no longer apply.
