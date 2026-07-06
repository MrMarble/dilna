# Thin Agent interface with pluggable adapters; opencode is the first adapter

## Context

dilna's MVP runs `opencode serve` per worktree, but the product is intended to support other agent backends later — claude-agent-sdk, custom OpenAI-API agents. If the Hono handlers call `opencode-sdk-js` directly, adding a second backend means refactoring session lifecycle, streaming, and storage code across many files.

## Decision

Define a thin `Agent` interface (in `apps/server/src/agents/` — kept out of `packages/shared` because it owns process lifecycle, which is server-only). One implementation ships at MVP: `OpencodeAgent`, which spawns `opencode serve` per worktree and uses `@opencode-ai/sdk` to drive it.

The dilna **Session** record carries an `agentType` field from day one (default `'opencode'`). Even though only one type ships at MVP, the field exists so adding `ClaudeAgent` later does not require a data-model migration.

Adapters own their own process/lifecycle details: `OpencodeAgent` spawns a child `opencode serve` and connects over HTTP; a future `ClaudeAgent` might import an SDK in-process. That difference is encapsulated inside the adapter — dilna's SessionManager only sees `agent.start() / agent.chat() / agent.stop()`.

Adapters normalize the backend's streaming events into a dilna-internal event union (`{ type: 'token', ... } | { type: 'tool_call', ... } | { type: 'done' }`). Persisted message history and the live SSE stream to the browser both use the normalized shape — we never store raw opencode/claude blobs.

## Why an interface with one implementation (and not inline or full abstraction)

- **Inline rejected (7a):** the second backend would touch 10+ files. An interface from day one localizes the change to a single new adapter file.
- **Full permission/tool/profile abstraction rejected (7c):** we don't yet know what permission or persistence configs the other backends will need. Decide that when the second backend is actually built.
- **Refactoring later is fine:** the interface is intentionally minimal — start, chat, stream, stop, resume, list messages. If a third backend reveals we need more, we extend the interface then; pre-designing it now is overengineering.

## Consequences

- One extra file of abstraction at MVP (`OpencodeAgent` behind an `Agent` interface). Negligible cost.
- `agentType` column on Session from day one — small schema foresight, large migration avoided later.
- Stored messages are normalized, not backend-native. Means we can't naively replay an opencode session into claude, but we'd never want to — adapters translate dilna's normalized history into their backend's resume format.
- Adding a backend = writing one new `Agent` impl + registering it in the agent factory. No core-code changes.