# Turn durability across interruptions + live-turn replay for mid-turn subscribers

## Context

ADR-0003 accepted "no work-in-progress is preserved mid-tool-call — if the agent was mid-write when the server died, that work is lost" as an MVP trade-off. The product is past MVP, and chat history is its core contract: a Session's history must survive server restarts/crashes, and moving between devices (or reloading) mid-turn must show the turn in progress, not a blank pane.

Reality before this ADR, all consequences of persisting everything only at turn end (in `sendMessage`'s `finally`):

1. **A restart mid-turn lost the whole turn.** Boot-time `resetAllToIdle` even deleted the pending-user placeholder, so the *user's own message* vanished.
2. **A restart during a session's first turn orphaned the session permanently.** The Claude-side `agentSessionId` was also only persisted at turn end, so the DB row kept `null` — the next send started a fresh Claude session, the transcript holding all the agent's work was never referenced again, and dilna's chat stayed empty forever despite modified files in the worktree.
3. **A subscriber connecting mid-turn rendered nothing.** The turn's `message_start` (emitted once per turn) had already been broadcast; without it the client dropped every subsequent `tool_call_start`/`tool_call_end`, and the DB had nothing to serve yet. On tool-heavy turns the pane stayed blank until the turn ended — and stayed blank even then, because the client's idle-time history reconcile was gated on having seen the working-status flip.
4. **The Stop button wedged the turn.** `ClaudeHandle.stop()` cleared listeners without resolving in-flight `chatClaude` calls, so `sendMessage` hung until the 10-minute turn timeout, then spuriously marked the session crashed.

## Decision

Durability comes from recognizing that **the Claude-native transcript (a JSONL file under `CLAUDE_CONFIG_DIR`, already on the persistent volume per ADR-0009) is the durable record of an in-flight turn**. dilna's job is to never lose the key into it and to reconcile from it after any interruption. Concretely:

- **`agentSessionId` is persisted the moment the first turn's `init` handshake reports it** (`onInit` callback on `ClaudeStartOptions`), not at turn end. An interrupted turn always leaves a resumable id behind.
- **Boot-time recovery:** `resetAllToIdle` backfills every previously working/starting/stopping session from its transcript (`getSessionMessages` needs no live process) before flipping it idle. The pending-user placeholder is *dropped* only when the transcript carried the user's message (an authoritative row now exists); otherwise it is *promoted* to a permanent row (fresh id, content untouched). The same drop-or-promote rule applies at normal turn end. A restart never deletes the user's message.
- **Live-turn snapshot for mid-turn subscribers:** SessionManager mirrors the in-flight turn's broadcast events into an in-memory `LiveTurn` (same merging rules as the client's live state). `subscribe()` replays a `working` status plus the snapshot (as ordinary `message_start`/`token`/`tool_call_*` events) to any listener that connects mid-turn, so replayed and live-from-the-start subscribers converge on identical state. The snapshot is cleared only after the turn's rows are persisted, so a subscriber never sees neither. The client, in turn, creates a live entry from a `tool_call_start` it has no `message_start` for instead of dropping it.
- **`stop()` emits one terminal idle event to listeners before clearing them**, so in-flight `chatClaude` calls resolve and run their normal end-of-turn persistence over the partial turn.

The DB remains the sole durable source of truth for history (ADR-0004); the `LiveTurn` snapshot is a rendering catch-up mechanism, never persisted, exactly like the SSE stream it feeds.

## Why not incremental DB writes per event

Writing every token/tool event into SQLite as it streams would also close the gap, but:

- The transcript already *is* the incremental durable record — the Claude CLI appends it as the turn progresses. Duplicating that write stream into SQLite buys durability only for the window where the transcript write lags the event (sub-second), at the cost of write amplification on every token and a second, always-on reconciliation path between provisional and final rows (the provisional-row bugs around timestamps were the hardest part of the existing design).
- Server death kills the CLI child process with it, so there is no failure mode where dilna's DB could have captured more than the transcript did — they share the same disk and die together.

## Why promote (rename) the placeholder instead of keeping or deleting it

- Deleting loses the user's message — the incident this ADR exists to prevent.
- Keeping it under the stable `pending-user-<sessionId>` id collides with the next turn's placeholder insert (the id is deliberately one-per-session).
- Promotion is idempotent-safe: it only fires when the transcript verifiably lacks the user row, so the duplicate-message window is limited to a transcript that becomes readable *after* recovery already promoted — a window that requires the CLI to flush after its process died.

## Consequences

- Sessions survive server restarts mid-turn: on boot the turn-so-far is backfilled from the transcript, and the next send resumes the same Claude session (cold-resume per ADR-0003) with full context — equivalent to "continue" after killing Claude Code mid-turn.
- A page reload or second device mid-turn renders the full turn-so-far immediately (persisted history from the DB + live-turn snapshot via SSE) and keeps streaming from there.
- `resetAllToIdle` now does file IO per interrupted session on boot. Bounded by the number of sessions that were mid-turn at death (usually 0–2).
- The live-turn snapshot is Claude-shaped only in name — it's built from normalized `AgentStreamEvent`s, so a future second backend (ADR-0002) gets it for free; only the transcript-backfill path is backend-specific and lives behind the adapter boundary.
- Deleting a session still prunes all of it from the DB (unchanged); durability guarantees apply only while the session exists.
