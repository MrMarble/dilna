# Claude Agent SDK — in-turn signals available to dilna

Research for Wayfinder ticket [Research: in-turn signals exposed by the Claude Agent SDK](https://github.com/MrMarble/dilna/issues/37) (child of the "Map: agent-chat event-protocol spec" map, #32). Grounded by reading the installed `@anthropic-ai/claude-agent-sdk@0.3.203` type declarations directly (`sdk.d.ts`, plus the bundled `@anthropic-ai/sdk@0.110.0` for the raw streaming-event shapes) — the same method as `claude-agent-sdk-usage-limits.md`, and for the same reason: the installed SDK is the ground truth for what dilna can consume, not docs recall.

**Purpose:** give the feedback-spec ticket ([Specify in-turn feedback events and their rendering](https://github.com/MrMarble/dilna/issues/38)) the complete menu of what *can* be surfaced. This doc enumerates and classifies; it decides nothing.

## 0. What dilna consumes today

`apps/server/src/agents/claude.ts` runs the SDK in streaming-input mode with `includePartialMessages: true` and consumes exactly:

- `system/init` → captures `session_id` + `apiKeySource` (side channel, `claude.ts:410`)
- `rate_limit_event` → forwarded to the usage footer (`claude.ts:416`)
- `assistant` (complete messages) → normalized to `message_start`/`tool_call_start`/`tool_call_end`/`message_end`
- `stream_event` → **only** `message_start` (to learn the API message id) and `content_block_delta`+`text_delta` (the `token` events); every other raw event is dropped (`claude.ts:695–735`)
- `user` → tool results
- `result` → turn end / error detection

Everything else in the 39-member `SDKMessage` union falls through `normalizeMessage`'s default and is silently discarded.

## 1. The partial-message stream (`includePartialMessages`)

`SDKPartialAssistantMessage` = `{ type: 'stream_event', event: BetaRawMessageStreamEvent, parent_tool_use_id: string | null, uuid, session_id, ttft_ms? }`. This is the **only** message type gated by `includePartialMessages`; every other signal in this doc is emitted regardless of that flag.

`BetaRawMessageStreamEvent` is the raw Anthropic streaming union:

| Event | Payload | In-turn signal value |
|---|---|---|
| `message_start` | the shell `BetaMessage` | turn's API message id (dilna uses this) |
| `content_block_start` | `content_block` (text, **thinking**, redacted_thinking, tool_use, server_tool_use, MCP tool use/result, web_search/web_fetch results, compaction, …) + `index` | "the model is now thinking / calling tool X" — fires **before** any delta of that block |
| `content_block_delta` | one of the deltas below | the incremental content itself |
| `content_block_stop` | `index` | block finished |
| `message_delta` | `stop_reason`, cumulative `usage` | end-of-stream metadata |
| `message_stop` | — | API stream closed |

`BetaRawContentBlockDelta` variants:

- `text_delta { text }` — dilna's `token` events today.
- `thinking_delta { thinking, estimated_tokens }` — **visible thinking text**, streamed exactly like text. `estimated_tokens` is a lossy running counter that is non-null only when thinking display resolves to "omitted" (redacted phase).
- `input_json_delta { partial_json }` — **partial tool input**: the tool call's JSON arguments streaming in before the call executes. Rendering "what file is it about to edit" live requires accumulating these per block index.
- `signature_delta`, `citations_delta`, `compaction` delta — protocol plumbing; no obvious chat-feedback value.

Correlation note: raw events are per-`index`, not per-tool-id; the tool_use block's id arrives in its `content_block_start`. A consumer that wants live partial input must map `index → tool_use_id` from the start event.

## 2. Thinking / reasoning

Two independent channels:

1. **Visible thinking**: `content_block_start` with a `thinking` block, then `thinking_delta` frames (§1). Requires `includePartialMessages` for the live stream; the complete `thinking` block also lands in the final `SDKAssistantMessage.message.content` (dilna's normalizer currently reads only `text` and `tool_use` blocks, so it drops thinking there too).
2. **Redacted-thinking progress**: `SDKThinkingTokensMessage` (`system/thinking_tokens`, `{ estimated_tokens, estimated_tokens_delta }`) — a digested live token-count for the phase where the API streams only pings. Explicitly documented as "approximate progress for spinners/pills". Not gated by any option.

## 3. Subagent activity

- `parent_tool_use_id: string | null` rides on `assistant`, `user`, and `stream_event` messages. Non-null ⇒ the message originated inside a subagent (the id is the spawning `Task` tool_use). **By default only tool_use/tool_result blocks from subagents are forwarded** — enough for a heartbeat counter.
- `forwardSubagentText?: boolean` (option, default false) — when true, the subagent's full text/thinking is forwarded as normal assistant/user messages with `parent_tool_use_id` set, enabling a nested-transcript rendering.
- `subagent_type?` / `task_description?` on assistant/user messages identify which subagent produced them.
- Task lifecycle (all `type: 'system'`, unconditional):
  - `task_started { task_id, tool_use_id?, description, subagent_type?, task_type?, prompt?, skip_transcript? }`
  - `task_progress { task_id, description, usage: { total_tokens, tool_uses, duration_ms }, last_tool_name?, summary? }` — periodic heartbeat with a live token/tool counter and the subagent's last tool.
  - `task_updated { task_id, patch: { status?, description?, end_time?, error?, is_backgrounded? } }` — merge-patch on a client-side task map.
  - `task_notification { task_id, status: completed|failed|stopped, summary, usage?, output_file }` — terminal bookend.
  - `background_tasks_changed { tasks: [{task_id, task_type, description}] }` — **level-based** replace-your-set signal for "is background work running" (its docs warn not to pair edges; consumers reset the set on process restart). Notably aligned with the level-based philosophy locked in #33.

## 4. Tool progress

- `SDKToolProgressMessage` (`type: 'tool_progress'`, unconditional): `{ tool_use_id, tool_name, parent_tool_use_id, elapsed_time_seconds, task_id? }` — periodic "tool X has been running N seconds" ticks for long-running calls. This is the missing ingredient for a live elapsed-time badge on a running tool call.
- `input_json_delta` (§1) covers the pre-execution phase (arguments streaming).
- `SDKToolUseSummaryMessage` (`type: 'tool_use_summary'`): `{ summary, preceding_tool_use_ids }` — a model-authored one-liner summarizing a burst of tool calls, for collapsed rendering.
- `SDKPermissionDeniedMessage` (`system/permission_denied`): a tool call auto-denied without a prompt (deny rule, dontAsk, classifier), with `tool_name`, `tool_use_id`, `decision_reason`. Otherwise the only trace is an `is_error` tool_result.

## 5. Queued-command visibility

In streaming-input mode, user messages pushed while a turn runs are queued by the CLI. Visibility is thin:

- `SDKUserMessage.priority?: 'now' | 'next' | 'later'` — the sender's queue hint (input side).
- `SDKUserMessageReplay` (`type: 'user'`, `isReplay: true`, guaranteed `uuid`) — the CLI echoing a user message back; the ack that a queued message was accepted into the transcript. dilna's normalizer currently treats replays like any user message.
- Control request `cancel_async_message { message_uuid }` — drop a still-queued message by uuid (no-op if already dequeued).
- There is **no** "queue contents changed" event; a queue UI would have to be built from these three pieces.

## 6. Turn-phase and session-state signals

- `SDKStatusMessage` (`system/status`): `status: 'compacting' | 'requesting' | null`, plus `compact_result`/`compact_error` — coarse in-turn phase ("compacting context…", "waiting for API…", null = phase over).
- `SDKSessionStateChangedMessage` (`system/session_state_changed`): `state: 'idle' | 'running' | 'requires_action'` — documented as the "authoritative turn-over signal". Overlaps dilna's manager-owned `session_status` (#33); relevant as adapter-internal input, not as a new client event.
- `SDKCompactBoundaryMessage` (`system/compact_boundary`): `{ trigger: manual|auto, pre_tokens, post_tokens?, duration_ms? }` — context was compacted mid-turn.
- `SDKAPIRetryMessage` (`system/api_retry`): `{ attempt, max_retries, retry_delay_ms, error_status, error }` — the API call failed and will retry; the exact "why is it hanging" signal for a stalled-looking turn.
- `SDKInformationalMessage` (`system/informational`): plaintext banner with `level: info|notice|suggestion|warning` and optional `prevent_continuation` — hook feedback, status lines. Shape-compatible with the `notice` event dilna locked in #34.
- `SDKNotificationMessage` (`system/notification`): REPL-style notification queue (`key`, `text`, `priority`, `timeout_ms`).
- `SDKModelRefusalFallbackMessage` / `SDKModelRefusalNoFallbackMessage`: model refused; either retried on a fallback model (with `retracted_message_uuids` to evict already-rendered content — a genuinely new protocol concern) or errored.
- `SDKConversationResetMessage` (`type: 'conversation_reset'`): transcript replaced under a new conversation id (`/clear`, plan-mode exit).

## 7. Hook events (`includeHookEvents`, default false)

`hook_started` / `hook_progress` / `hook_response` (`system/*`): `{ hook_id, hook_name, hook_event, stdout, stderr, output, outcome }` bracketing every hook execution. SessionStart/Setup hooks are emitted regardless of the flag. Only relevant if dilna sessions ever run user-configured hooks.

## 8. Present but not in-turn-feedback material

For completeness, the remaining union members and why they're out of the feedback menu: `system/init` (consumed), `result` (consumed), `rate_limit_event` (consumed), `auth_status`, `plugin_install`, `commands_changed`, `files_persisted`, `memory_recall`, `prompt_suggestion` (post-turn, needs opt-in), `mirror_error`, `worker_shutting_down`, `elicitation_complete`, `control_request_progress`, `local_command_output`. None are impossible to surface; none are in-turn agent-activity signals.

## 9. Option-gating summary

| Option | Gates | Default |
|---|---|---|
| `includePartialMessages` | `stream_event` (all of §1: text/thinking deltas, partial tool input, block starts) | off (dilna: **on**) |
| `forwardSubagentText` | subagent text/thinking as parented messages (§3) | off |
| `includeHookEvents` | `hook_started`/`hook_progress`/`hook_response` (§7) | off |
| `thinking` config | whether thinking blocks exist at all | adaptive on supported models |
| — (unconditional) | everything else: tool_progress, task_*, thinking_tokens, status, api_retry, informational, compact_boundary, permission_denied, refusal pair, replays | — |

## 10. Shortlist for the feedback spec

The candidates with clear chat-feedback value, roughly ordered by leverage:

1. **Thinking deltas** (`thinking_delta`) + `thinking_tokens` progress — "the agent is reasoning" with real content or a live counter.
2. **Tool elapsed-time ticks** (`tool_progress`) — long tool calls stop looking frozen.
3. **In-turn phase** (`status`: compacting/requesting; `api_retry`) — explains every stall the above two don't.
4. **Subagent lifecycle** (`task_started`/`task_progress`/`task_notification`, `parent_tool_use_id`) — visibility into the currently-invisible Task bursts.
5. **Partial tool input** (`input_json_delta`) — show the command/file a tool call is forming before it runs.
6. **Tool-use summaries** (`tool_use_summary`) — collapsed rendering of tool bursts.
7. **Refusal retraction** (`retracted_message_uuids`) — the only item that would *change* the protocol's assumptions (an event that removes already-streamed content).
