# Claude Agent SDK — usage/token/rate-limit data available to dilna

Research for Wayfinder ticket "Investigar datos de uso/límites del Claude Agent SDK / API Anthropic" (child of the "Mapa: dilna usable — mobile, sidebar de cambios y stats de uso" map). Grounded by reading the installed `@anthropic-ai/claude-agent-sdk@0.3.203` type declarations directly (`sdk.d.ts` in `node_modules/.pnpm/...`), not from training-data recall — the SDK's own bundled docs are the source of truth here, not the Claude API docs skill (which explicitly excludes the Agent SDK from its scope).

dilna's `apps/server/src/agents/claude.ts` currently discards all of the data described below: `normalizeAssistantMessage` reads only `text`/`tool_use` content blocks, `normalizeResultMessage` reads only `subtype`/`errors`, and `normalizeMessage`'s switch has a `default: return []` that silently drops every other `SDKMessage` subtype — including the rate-limit event described below.

## 1. Per-turn usage (available today, currently dropped)

**Every assistant message** (`SDKAssistantMessage`, `msg.type === "assistant"` in `claude.ts`'s `normalizeMessage` switch) wraps a full Anthropic API `BetaMessage` at `msg.message`, which carries a standard `.usage` object:

- `input_tokens`, `output_tokens` (required, non-null)
- `cache_creation_input_tokens`, `cache_read_input_tokens` (nullable)
- `cache_creation` — breakdown by TTL
- `inference_geo` — region inference ran in
- a per-iteration breakdown array (server-side tool-use loops)

This is the same `usage` shape documented for the Messages API in general (`shared/prompt-caching.md` / `shared/token-counting.md` in the claude-api skill) — nothing Agent-SDK-specific, just present on every assistant turn.

**End of turn** (`SDKResultMessage`, `msg.type === "result"`, handled in `normalizeResultMessage`) carries turn-level and cumulative-session totals:

```ts
type SDKResultSuccess = {
  type: 'result'; subtype: 'success';
  duration_ms: number; duration_api_ms: number;
  num_turns: number;
  total_cost_usd: number;
  usage: NonNullableUsage;              // same shape as BetaUsage, non-null fields
  modelUsage: Record<string, ModelUsage>; // per-model breakdown, see below
  // ...
};
```

`ModelUsage` (per model id, e.g. when a session mixes models via subagents):

```ts
type ModelUsage = {
  inputTokens: number; outputTokens: number;
  cacheReadInputTokens: number; cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number; maxOutputTokens: number;
};
```

`total_cost_usd` and `usage` on `SDKResultMessage` were originally believed to be **cumulative for the whole CLI session** — the SDK's doc comments read that way. **Empirically false in streaming-input mode** (verified 2026-07: two turns in one process reported `input_tokens` 3319 then 2, `num_turns: 1` each time — per-turn values, not a running sum; and a resumed process likewise reports only its own turns). Treat `SDKResultMessage.usage` as **that turn's usage**; any session-lifetime total is dilna's own bookkeeping (see `SessionManager.accumulateSessionUsage` and the `sessions.input_tokens`/`output_tokens` columns).

**Where this plugs in:** `normalizeResultMessage` (claude.ts:544) already special-cases `msg.subtype !== "success"`; extending it to read `usage`/`total_cost_usd`/`modelUsage` from the success branch and emitting a new `AgentStreamEvent` variant (e.g. `usage_update`) is the natural hook. This directly informs the "stats de uso de sesión (tokens)" ticket (Especificar qué stats de uso mostrar y dónde) once it's unblocked.

## 2. Account/plan-level usage & rate limits

Two distinct mechanisms, both **experimental** and **conditional on auth mode** (see §3):

### a. `SDKRateLimitEvent` (push, part of the `SDKMessage` union)

Emitted automatically whenever rate-limit info changes — no polling needed, but it's a message type in the union that `claude.ts`'s `normalizeMessage` switch currently falls through to `default: return []` and silently drops.

```ts
type SDKRateLimitEvent = {
  type: 'rate_limit_event';
  rate_limit_info: {
    status: 'allowed' | 'allowed_warning' | 'rejected';
    resetsAt?: number;
    rateLimitType?: 'five_hour' | 'seven_day' | 'seven_day_opus' | 'seven_day_sonnet' | 'seven_day_overage_included' | 'overage';
    utilization?: number;               // 0–100
    overageStatus?: 'allowed' | 'allowed_warning' | 'rejected';
    overageResetsAt?: number;
    overageDisabledReason?: /* one of several enum reasons, e.g. 'out_of_credits', 'org_level_disabled', ... */ string;
  };
};
```

This is explicitly documented as "Rate limit information for claude.ai subscription users" — i.e. it only fires meaningfully under OAuth/subscription auth (see §3).

### b. `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` (pull, on-demand)

The `Query` object returned by `query()` (dilna's `handle.query` in `ClaudeHandle`) exposes a method — the name itself is a loud warning that the shape/existence is not stable — that returns the structured data behind the CLI's `/usage` command:

```ts
type SDKControlGetUsageResponse = {
  session: {
    total_cost_usd: number;
    total_api_duration_ms: number;
    total_duration_ms: number;
    total_lines_added: number;
    total_lines_removed: number;
    model_usage: Record<string, ModelUsage>;
  };
  subscription_type: string | null;   // 'pro' | 'max' | 'team' | 'enterprise' | null
  rate_limits_available: boolean;     // false for API key / Bedrock / Vertex / missing profile scope
  rate_limits: {
    five_hour?: { utilization: number | null; resets_at: string | null } | null;
    seven_day?: { utilization: number | null; resets_at: string | null } | null;
    seven_day_oauth_apps?: { utilization: number | null; resets_at: string | null } | null;
    seven_day_opus?: { utilization: number | null; resets_at: string | null } | null;
    seven_day_sonnet?: { utilization: number | null; resets_at: string | null } | null;
    model_scoped?: { display_name: string; utilization: number | null; resets_at: string | null }[];
    extra_usage?: { is_enabled: boolean; monthly_limit: number | null; used_credits: number | null; utilization: number | null; currency?: string | null } | null;
  } | null;
  behaviors: { day: {...}, week: {...} } | null; // local-transcript-scan attribution (skills/agents/plugins/MCP), claude.ai-subscriber only
};
```

This is the closest thing to "the real limit of the account/plan" the ticket asked about — 5-hour and 7-day windows, per-model (Opus/Sonnet) sub-windows, and overage/extra-usage credit state, sourced from the claude.ai usage endpoint. There's also a lighter `getContextUsage()` method (context-window capacity breakdown by category — system prompt, tools, messages, etc.) which is a different concept (context size, not spend/quota) but worth knowing about.

**Caveat to flag on the map/spec:** the method name (`usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`) and its doc comment ("EXPERIMENTAL: this API is unstable and may change or be removed in any release without notice — do not rely on it yet. The method name will change when the API is stabilized.") are explicit upstream warnings. Building a shipped feature on it means accepting breakage risk on SDK upgrades, or treating its absence/shape-change as a soft-fail (feature degrades gracefully rather than crashing the session).

## 3. Does this differ between direct API key auth and Claude Pro/Max subscription login?

**Yes, explicitly gated in the SDK's own types and doc comments:**

- `rate_limits_available` is **`false`** (and `rate_limits` is **`null`**) for API key, Bedrock, Vertex, and other sessions where plan limits don't apply, or where the auth profile is missing the required scope. It's only populated for a claude.ai subscription login (Pro/Max/Team/Enterprise via OAuth).
- `subscription_type` mirrors this: a real value (`'pro' | 'max' | 'team' | 'enterprise'`) under OAuth login, `null` under API key / third-party-provider auth.
- `behaviors` (the local-transcript usage-attribution breakdown) is likewise `null` for "non-claude.ai-subscriber sessions."
- `SDKRateLimitEvent`'s doc comment is explicit: "Rate limit information for **claude.ai subscription users**."

**How to detect which mode a session is in, right now, without the experimental call:** the `SDKSystemMessage` with `subtype: 'init'` — the same message `claude.ts`'s `startClaude` already parses to pull `agentSessionId` (claude.ts:240-242) — carries `apiKeySource: 'user' | 'project' | 'org' | 'temporary' | 'oauth'`. `'oauth'` means Claude Pro/Max (or Team/Enterprise) subscription login; the other four values are all API-key-shaped auth (direct key, project-scoped, org-scoped, or a short-lived temporary key). This field is available on the very first message of every session and is not experimental.

**What the bare Anthropic API (not the Agent SDK) exposes, for contrast:** the Messages API itself has no account/plan-quota endpoint — that's a claude.ai/Console-side concept, not a Messages API resource. What it does expose, on any request (API key or OAuth token alike, since it's HTTP-level), is rate-limit *headers* on 429s and normal responses (`retry-after`, `x-ratelimit-limit-*`, `x-ratelimit-remaining-*` — see the claude-api skill's `shared/error-codes.md`). Those are organization/API-key RPM/TPM/TPD limits — a different concept from the claude.ai subscription's 5-hour/7-day usage windows described above, and orthogonal to which auth mode is active.

## Summary for the map

| Question | Answer |
|---|---|
| Per-turn token usage in stream events? | Yes — every `assistant` message's `.message.usage` (Messages-API shape); every `result` message's cumulative `usage`/`total_cost_usd`/`modelUsage`. Not currently read by `claude.ts`. |
| Account/plan quota or rate limits? | Yes, but **experimental** and **only for claude.ai OAuth subscriptions** — `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` (pull) and `SDKRateLimitEvent` (push). Null/unavailable for API-key auth. |
| Does auth mode change what's available? | Yes — gated explicitly by the SDK. Detect the mode cheaply via `system init`'s `apiKeySource` (`'oauth'` = subscription; anything else = API key family). |
| Anything from the bare Anthropic API? | Only generic per-request rate-limit headers (org/key RPM·TPM·TPD) — no plan-quota concept exists there; that's a claude.ai-specific surface the Agent SDK proxies. |
