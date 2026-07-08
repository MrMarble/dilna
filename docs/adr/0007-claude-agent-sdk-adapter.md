# ClaudeAgent adapter: `@anthropic-ai/claude-agent-sdk` in streaming-input mode, one query per worktree

> **Note (ADR-0011)**: the `handle.kind` dispatch this ADR describes was
> removed once `ClaudeAgent` became the only backend — `SessionManager` now
> calls it directly rather than branching. The adapter design itself
> (streaming-input mode, transcript re-sync) is unchanged.

## Context

ADR-0002 shipped `OpencodeAgent` as the only `Agent` implementation at MVP but reserved `agentType` on the Session record specifically so a second backend wouldn't need a migration. This ADR adds that second backend: `ClaudeAgent`, built on `@anthropic-ai/claude-agent-sdk` (the TypeScript SDK for driving Claude Code programmatically).

Unlike opencode, the Claude Agent SDK has no long-running server to connect a client to. Its `query()` function spawns a Claude Code CLI subprocess per call and returns an async generator of `SDKMessage`s. To keep one resident process per worktree for a session's lifetime (matching ADR-0003's process model) rather than spawning a fresh subprocess per user message, `ClaudeAgent` uses the SDK's **streaming-input mode**: `query()` is called once with `prompt` set to an async iterable we control, and subsequent user turns are pushed into that iterable rather than triggering a new `query()` call.

## Decision

`apps/server/src/agents/claude.ts` exports `startClaude`/`chatClaude`, mirroring `startOpencode`/`chatOpencode`'s shape so `SessionManager` can dispatch on `session.agentType` with a small `handle.kind` discriminant (`OpencodeHandle | ClaudeHandle`) rather than a heavier interface abstraction — consistent with ADR-0002's "full abstraction rejected until the second backend is built"; now that it's built, the two adapters share only what `SessionManager` actually needs (`agentSessionId`, `listeners`, `stop`, `isAlive`).

**Process model:** one `query()` call per active session, fed by a hand-rolled async-iterable queue (`createInputQueue`) that `chatClaude` pushes user turns into. The query's own async generator runs a persistent background loop for the handle's lifetime, normalizing `SDKMessage`s into dilna's `AgentStreamEvent` union and broadcasting to listeners — the same shape as opencode's `runEventLoop`.

**Permissions:** `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions: true`, the Claude Agent SDK equivalent of opencode's `OPENCODE_CONFIG_CONTENT='{"permission":"allow"}'`. Same rationale as ADR-0003: the agent runs in an isolated worktree, so auto-approving tool calls is safe, and the stop button is the manual override.

**Event normalization:** Claude's tool-call protocol splits a call across two transcript entries — the `tool_use` block lives in an assistant message, its result arrives as a `tool_result` block in a later *synthetic* user message the CLI generates internally. `ClaudeAgent` tracks `callId -> messageId` when it sees `tool_use` so the paired `tool_result` can still emit a `tool_call_end` against the same `messageId`, keeping the live-event shape identical to opencode's merged pending/completed tool part. Text streams as one `token` event per completed assistant message rather than per-character deltas (opencode's `message.part.updated` deltas have no direct equivalent in the SDK's non-partial message stream) — a deliberate scope cut for this first cut; `includePartialMessages` is available if char-level streaming becomes worth the added complexity later.

**Message persistence:** like opencode, dilna treats the backend's own transcript as the source of truth and re-syncs after each turn rather than aggregating from live events. `getSessionMessages(sessionId, { dir: worktreePath })` (an SDK export, reading the CLI's own JSONL transcript) replaces `client.session.messages()`. Synthetic tool-result user entries are merged back into the owning assistant message's `tool_call` part during conversion, matching opencode's `tool_call` shape (call + result as one part) rather than dilna's schema growing a separate "tool result" message type.

**Credentials:** no `env` override is passed to `query()`, so the spawned CLI subprocess inherits `process.env` — the same host-pass-through model as ADR-0005 (the user runs `claude` (or sets `ANTHROPIC_API_KEY`) once on the host; dilna never manages Claude credentials itself).

## Why streaming input over one `query()` per message

- **Process reuse:** a fresh `query()` per message would respawn the Claude Code CLI on every turn, losing the in-process conversation state the CLI keeps warm (and paying subprocess-spawn latency every message). Streaming input keeps one subprocess resident across a session's turns, matching the "one process per worktree" model from ADR-0003.
- **`resume` still available for cold start:** when dilna itself restarts (per ADR-0003, resident agents don't survive a server restart), a fresh `startClaude` call passes `resume: session.agentSessionId` to reconnect to the same Claude-side session history — the streaming-input process is new, but the conversation isn't.

## Why re-derive messages from the transcript over aggregating live events

- Same reasoning as opencode: replaying/aggregating a live event stream into `MessagePart[]` ourselves risks drifting from what the backend actually persisted (partial writes on crash, reordering, retried tool calls). Reading `getSessionMessages` after each turn is one straight, backend-authoritative pass — see ADR-0006's "aggregated persisted form over event log."
- The transcript has no timestamp field, so `createdAt` is synthesized as `now + index` per batch to preserve transcript order. This is a readable-order hack, not a real clock; acceptable because dilna only orders by `createdAt` within a session, never compares across sessions.

## Consequences

- `SessionManager` now branches on `handle.kind` in four places (`sendMessage`'s chat call, `persistMessagesFromAgent`, `maybeSyncTitle`, `ensureStarted`'s start call) instead of calling opencode functions directly. `openai` (the third `AgentType` value reserved since ADR-0002) throws a clear "not implemented yet" error at both session-create and session-start time rather than silently falling through to a default backend.
- No character-level token streaming for Claude sessions yet (whole-message chunks instead) — a scope cut to keep this adapter's first version correct and reviewable; revisit with `includePartialMessages` if the UX gap matters.
- `docs/adr/0002-agent-interface-adapters.md`'s prediction ("adding a backend = writing one new `Agent` impl + registering it") holds at the adapter level; the small `handle.kind` dispatch in `SessionManager` is the "registering it" part, kept inline rather than behind a formal `AgentFactory` since two backends still don't justify the extra indirection layer.
- Session creation now accepts an optional `agentType` end-to-end (`POST /api/sessions { repoId, agentType }`); no session-creation UI picker was added in this change — the web app still defaults to opencode when the caller omits `agentType`.
