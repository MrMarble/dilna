# dilna-native event + message union as the contract between agents and consumers

## Context

ADRs 0002 (agent interface) and 0004 (persistence) both require "normalized events" and "normalized message history" but don't define the shape. Every adapter (`OpencodeAgent` now, `ClaudeAgent` later) emits events; every consumer (DB writer, SSE stream to browser, chat UI) reads them. Getting this contract wrong now means painful data migrations once rows exist.

## Decision

`packages/shared` owns two TypeScript unions. Adapters emit live `AgentStreamEvent`s via SSE; the DB stores aggregated `Message` rows with `MessagePart[]` content.

```ts
// Live SSE event stream (server -> browser)
type AgentStreamEvent =
  | { type: 'session_status', status: 'idle' | 'starting' | 'working' | 'stopping' | 'crashed' }
  | { type: 'message_start', messageId: string, role: 'user' | 'assistant' }
  | { type: 'token', messageId: string, chunk: string }
  | { type: 'tool_call_start', callId: string, tool: string, input: unknown }
  | { type: 'tool_call_end', callId: string, output: unknown, error?: string }
  | { type: 'message_end', messageId: string }
  | { type: 'error', message: string, stderrTail?: string[] }
  | { type: 'agent_crashed', exitCode: number, stderrTail: string[] };

// Persisted message in DB
type Message = {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  parts: MessagePart[];
  createdAt: number;
};
type MessagePart =
  | { type: 'text', text: string }
  | { type: 'tool_call', callId: string, tool: string, input: unknown, output: unknown, error?: string };
```

**Live stream is granular, persisted form is aggregated.** Token events arrive chunk-by-chunk over SSE for snappy UI; the DB only stores one `Message` row per turn with a complete `parts[]` array, written when `message_end` fires (or on a periodic flush for crash recovery). On session resume the UI renders from the aggregated parts, never by replaying events.

**Tool calls are two events** (`tool_call_start` + `tool_call_end`) so the UI can show a throbber for long-running tools. No intermediate `tool_call_progress` at MVP — agents that stream sub-tool output (e.g. build stdout) get compressed to start + end.

**Messages are append-only.** No edit, regenerate, or delete of past messages at MVP. The `messages` table grows monotonically per session. Adding edit/regenerate later = drop the assistant row + everything after, then re-emit; bounded refactor.

**`session_status` rides the same SSE stream** as message events. No second control channel (per Q10). The sidebar's session-list SSE (per Q17) consolidates status across sessions; the per-session SSE stream here is for the open chat.

**`messageId` on every event** lets the browser correlate streaming chunks to the message they belong to. Single active assistant message at a time per session (lock-step per Q19), but the ID future-proofs for queueing.

**`stderrTail` only on `error`/`agent_crashed`** — never on normal events. We don't pipe agent stderr to the browser otherwise.

## Why these shapes (and not the alternatives)

- **Fine-grained tokens over aggregated message_parts:** best perceived latency; one row per chunk in DB would be insane so we aggregate on write. Live UI gets chunks, DB gets a finished row.
- **Two tool events over one combined:** lets the UI render a throbber for long-running tools (build/tests) without waiting for completion. One combined event would block the UI on every tool.
- **Aggregated persisted form over event log:** replaying events on resume is fiddly and re-runs rendering logic; rendering from aggregated parts is one straight pass. Trade-off: we lose per-event history (can't see "user saw this token at 3:01:14.502") — we don't want that anyway.
- **Append-only messages:** edit/regenerate is a real feature but a real cost. Defer.
- **`session_status` on the same SSE stream:** avoids a second subscription per chat tab. The sidebar's cross-session SSE remains a separate single subscription per app load.

## Consequences

- Adapters normalize backend-native events into this union on emit. Opencode's SSE event names map to these types inside `OpencodeAgent`; future `ClaudeAgent` does the same for claude's protocol.
- The DB schema for `messages.content_json` (per ADR-0004) holds `MessagePart[]`. Stored history is dilna-native, never opencode/claude blobs.
- Adding a new event type (e.g. `tool_call_progress` for live tool stdout) is additive — extend the union, ship new adapter code, older clients ignore unknown types. No migration.
- Resume reads aggregated parts from DB; live edit (mid-stream) of a message is not represented. If we ever support "edit this past message and re-run," the aggregated form makes the "drop everything after" semantics clean.