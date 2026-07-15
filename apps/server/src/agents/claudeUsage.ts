import { readFileSync } from "node:fs";
import path from "node:path";
import type { PulledRateLimits } from "../sessions/rateLimits";
import { CLAUDE_HOME } from "./claude";

/**
 * Account/plan usage fetched over the same HTTP surface the Claude Code
 * CLI's `/usage` command uses: `GET https://api.anthropic.com/api/oauth/usage`
 * authorized by the claude.ai OAuth access token. Verified against the live
 * endpoint (2026-07-14, Pro account): returns `five_hour`/`seven_day` objects
 * with `utilization` (0–100) and an ISO-8601 `resets_at` — the same shape
 * `pullRateLimitsToWindows` already parses.
 *
 * This replaces the Agent SDK's
 * `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` control
 * request as the pull source (see ADR-0015): that method's name was an
 * explicit upstream warning, and it did stop returning data. Going straight
 * to the endpoint also removes the old constraint that the pull only worked
 * while an agent process was still alive — this can run any time, e.g. when
 * a client connects and the footer has nothing fresh to show.
 *
 * Token sourcing mirrors ADR-0005 host-passthrough, in order:
 * 1. `CLAUDE_CODE_OAUTH_TOKEN` (docker deployment; long-lived token from
 *    `claude setup-token`, no expiry metadata to check).
 * 2. `$CLAUDE_CONFIG_DIR/.credentials.json` → `claudeAiOauth.accessToken`,
 *    skipped when past `expiresAt`. dilna deliberately does NOT refresh an
 *    expired token itself: OAuth refresh rotates the refresh token, and
 *    racing the CLI's own 401→refresh→retry writer against the same
 *    credentials file could log the user's real CLI out. Every live agent
 *    turn goes through the CLI, which refreshes and rewrites the file — so
 *    whenever sessions are actually consuming quota, the token is fresh.
 *
 * Missing/expired/unreadable credentials (also the macOS-keychain case, and
 * plain API-key auth where plan windows don't exist) soft-fail to `null`
 * with a logged reason, and the footer degrades to absent — same contract
 * the old SDK pull had.
 */

const OAUTH_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** Same beta header the CLI sends on its OAuth API calls. */
const OAUTH_BETA_HEADER = "oauth-2025-04-20";
/** The CLI's own timeout for this fetch. */
const USAGE_FETCH_TIMEOUT_MS = 5000;
/** Refuse a token about to expire mid-flight rather than eat a 401. */
const TOKEN_EXPIRY_SKEW_MS = 60_000;

/**
 * Extract a still-valid access token from `.credentials.json` contents, or
 * `null` (with a thrown-away reason string for the caller to log). Pure so
 * the parsing/expiry edge cases are unit-testable without touching the
 * filesystem.
 */
export function parseOauthCredentials(
	raw: string,
	nowMs: number,
): { accessToken: string } | { error: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { error: "credentials file is not valid JSON" };
	}
	const oauth = (parsed as { claudeAiOauth?: unknown } | null)?.claudeAiOauth;
	if (!oauth || typeof oauth !== "object") {
		return { error: "credentials file has no claudeAiOauth section" };
	}
	const { accessToken, expiresAt } = oauth as {
		accessToken?: unknown;
		expiresAt?: unknown;
	};
	if (typeof accessToken !== "string" || accessToken.length === 0) {
		return { error: "claudeAiOauth.accessToken missing" };
	}
	if (
		typeof expiresAt === "number" &&
		expiresAt - TOKEN_EXPIRY_SKEW_MS <= nowMs
	) {
		return {
			error: `OAuth access token expired at ${new Date(expiresAt).toISOString()} (a CLI/agent turn refreshes it; dilna won't rotate it itself)`,
		};
	}
	return { accessToken };
}

function resolveAccessToken(nowMs: number): string | null {
	const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
	if (envToken) return envToken;

	const credentialsPath = path.join(CLAUDE_HOME, ".credentials.json");
	let raw: string;
	try {
		raw = readFileSync(credentialsPath, "utf8");
	} catch {
		console.error(
			`[claude-agent] usage pull skipped: no OAuth token (CLAUDE_CODE_OAUTH_TOKEN unset, ${credentialsPath} unreadable)`,
		);
		return null;
	}
	const result = parseOauthCredentials(raw, nowMs);
	if ("error" in result) {
		console.error(`[claude-agent] usage pull skipped: ${result.error}`);
		return null;
	}
	return result.accessToken;
}

/**
 * Pull the account's plan rate-limit windows. Resolves to the
 * `five_hour`/`seven_day` window objects, or `null` on any failure —
 * unreachable endpoint, non-2xx (e.g. 401 from a token the CLI hasn't
 * refreshed yet), or no usable token. Never throws; every failure is logged
 * so a persistently stale footer stays diagnosable from server logs (the
 * lesson recorded on the old SDK-pull path).
 */
export async function fetchClaudeOauthUsage(deps?: {
	fetchImpl?: typeof fetch;
	nowMs?: number;
}): Promise<PulledRateLimits> {
	const nowMs = deps?.nowMs ?? Date.now();
	const token = resolveAccessToken(nowMs);
	if (!token) return null;

	const fetchImpl = deps?.fetchImpl ?? fetch;
	try {
		const res = await fetchImpl(OAUTH_USAGE_URL, {
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"anthropic-beta": OAUTH_BETA_HEADER,
			},
			signal: AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS),
		});
		if (!res.ok) {
			console.error(
				`[claude-agent] usage pull failed: GET /api/oauth/usage → ${res.status}`,
			);
			return null;
		}
		const body = (await res.json()) as PulledRateLimits;
		// Diagnostic only: pullRateLimitsToWindows silently drops a window whose
		// shape doesn't match what we assume (utilization: number, resets_at:
		// ISO string) — logging that shape here is what makes a
		// partially-populated footer (e.g. seven_day updates, five_hour never
		// does) diagnosable instead of a second round of silent data loss.
		for (const kind of ["five_hour", "seven_day"] as const) {
			const window = body?.[kind];
			console.error(
				`[claude-agent] usage pull window ${kind}: ${
					window === undefined
						? "absent"
						: window === null
							? "null"
							: `utilization=${typeof window.utilization} resets_at=${typeof window.resets_at}${
									typeof window.resets_at === "string"
										? ` (${window.resets_at})`
										: ""
								}`
				}`,
			);
		}
		return body;
	} catch (err) {
		console.error(
			`[claude-agent] usage pull failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}
