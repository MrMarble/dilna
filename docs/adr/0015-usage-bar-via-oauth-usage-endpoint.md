# Usage bar sourced from the claude.ai OAuth usage endpoint

## Context

The sidebar's plan-usage footer (five-hour / seven-day utilization bars) was
fed by two sources: the Agent SDK's push `rate_limit_event` (unreliable —
omits `utilization` below the SDK's own warning threshold, never fires for
the seven-day window) and, as the authoritative pull,
`Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`. That
method's name was an explicit upstream warning, and it came with a hard
constraint: it only worked while an agent process was still alive, so the
pull had to be squeezed in post-turn before the idle-timeout kill. The pull
then stopped returning data in practice, leaving the footer permanently
empty (docs/research/claude-agent-sdk-usage-limits.md records the original
investigation and its caveat that this exact breakage was the accepted
risk).

Meanwhile the Claude Code CLI's own `/usage` screen kept working. Inspecting
the CLI binary (2.1.209) shows how: it issues
`GET https://api.anthropic.com/api/oauth/usage` with the claude.ai OAuth
access token as a bearer, `anthropic-beta: oauth-2025-04-20`, and a 5s
timeout, retrying once through a 401→token-refresh→retry wrapper. Probed
live against a Pro account (2026-07-14), the endpoint returns `five_hour` /
`seven_day` objects with `utilization` (0–100) and ISO-8601 `resets_at` —
the same shape the SDK pull used to return, because the SDK was proxying
this endpoint all along.

## Decision

Replicate the CLI's fetch directly in `agents/claudeUsage.ts` and make it
the pull source (`fetchClaudeOauthUsage`), keeping the push event, the
`rate_limits` table, and the staleness-filtered broadcast pipeline
unchanged (`sessions/rateLimits.ts` just retypes the pull parser onto a
local `PulledRateLimits` shape instead of the SDK's type).

- **Token sourcing is host-passthrough (ADR-0005), never interactive**:
  `CLAUDE_CODE_OAUTH_TOKEN` if set (docker deployment), else
  `$CLAUDE_CONFIG_DIR/.credentials.json`'s `claudeAiOauth.accessToken`,
  skipped when past `expiresAt`.
- **dilna never refreshes the token itself.** OAuth refresh rotates the
  refresh token; a second refresher racing the CLI's own
  401→refresh→rewrite of the same credentials file could invalidate the
  user's real CLI login. Every live agent turn already runs through the
  CLI, which refreshes and rewrites the file — so the token is fresh
  exactly when quota is actually being consumed. An expired token between
  sessions degrades the footer to absent, matching the old soft-fail
  contract (and every skip/failure path logs a reason, preserving the
  diagnosability lesson from the old pull).
- **No live process needed anymore**, so the pull now also fires when a
  cross-session SSE client connects (routes/stream.ts), throttled to one
  pull per 60s inside `SessionManager` — a tab opened after an idle night
  shows real bars seconds after load instead of after the next turn.

## Why not the alternatives

- **Keep the SDK pull and wait for it to stabilize**: it broke in the way
  its name promised it would, and its live-process requirement is a real
  functional limit (empty footer until a turn runs). Nothing else consumed
  the experimental method, so dropping it removes the risk instead of
  re-accepting it.
- **Refresh the OAuth token from dilna when expired**: handles the
  idle-server window, but the rotation race above can log the user out of
  Claude Code everywhere — far worse than a temporarily absent footer.
- **Parse `anthropic-ratelimit-*` headers off API responses**: those are
  org/key RPM·TPM limits on Messages API calls, a different concept from
  plan windows, and dilna doesn't make those calls itself anyway.

## Consequences

- The footer works again, including on API-key-less idle servers, and the
  bar's data path no longer depends on any experimental SDK surface.
- dilna now depends on an undocumented claude.ai endpoint instead. That's
  judged the safer bet: it's the CLI's own data path for `/usage`, so it
  moves in lockstep with the product rather than with SDK refactors. If it
  does change shape, `pullRateLimitsToWindows` drops unparseable windows
  and the footer degrades to absent — same failure mode as before, never a
  crashed turn.
- The response carries more than the two bars show (per-model windows, a
  `limits` array, extra-usage credit state) — available cheaply if the UI
  ever wants them; the parser deliberately ignores them today.
