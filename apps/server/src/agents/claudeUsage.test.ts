import { describe, expect, it, vi } from "vitest";
import { fetchClaudeOauthUsage, parseOauthCredentials } from "./claudeUsage";

// Mirrors the on-disk `.credentials.json` the Claude CLI writes (Linux;
// probed 2026-07-14). Only the fields parseOauthCredentials reads, plus the
// siblings it must ignore.
function credentialsJson(overrides?: { expiresAt?: number }): string {
	return JSON.stringify({
		claudeAiOauth: {
			accessToken: "sk-ant-oat01-test-token",
			refreshToken: "sk-ant-ort01-test-token",
			expiresAt: overrides?.expiresAt ?? Date.now() + 8 * 3600_000,
			scopes: ["user:inference", "user:profile"],
			subscriptionType: "pro",
		},
	});
}

describe("parseOauthCredentials", () => {
	it("returns the access token while it is still valid", () => {
		const now = Date.now();
		const result = parseOauthCredentials(
			credentialsJson({ expiresAt: now + 3600_000 }),
			now,
		);
		expect(result).toEqual({ accessToken: "sk-ant-oat01-test-token" });
	});

	it("rejects an expired token instead of sending it and eating a 401", () => {
		const now = Date.now();
		const result = parseOauthCredentials(
			credentialsJson({ expiresAt: now - 1000 }),
			now,
		);
		expect(result).toHaveProperty("error");
	});

	it("rejects a token expiring within the skew window (about to die mid-flight)", () => {
		const now = Date.now();
		const result = parseOauthCredentials(
			credentialsJson({ expiresAt: now + 5000 }),
			now,
		);
		expect(result).toHaveProperty("error");
	});

	it("soft-fails on malformed JSON", () => {
		expect(parseOauthCredentials("not json", Date.now())).toHaveProperty(
			"error",
		);
	});

	it("soft-fails when the claudeAiOauth section is missing (API-key-only install)", () => {
		expect(parseOauthCredentials("{}", Date.now())).toHaveProperty("error");
	});
});

describe("fetchClaudeOauthUsage", () => {
	// The env token bypasses the credentials file entirely, so these tests
	// stay hermetic on machines with or without a real ~/.claude login.
	function withEnvToken(fn: () => Promise<void>): Promise<void> {
		vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-env-token");
		return fn().finally(() => vi.unstubAllEnvs());
	}

	it("requests the CLI's usage endpoint with bearer auth and parses the body", () =>
		withEnvToken(async () => {
			// Trimmed from a live response (2026-07-14): the endpoint returns far
			// more than the two windows; everything else must pass through ignored.
			const body = {
				five_hour: {
					utilization: 21.0,
					resets_at: "2026-07-14T23:39:59.819406+00:00",
					limit_dollars: null,
				},
				seven_day: {
					utilization: 62.0,
					resets_at: "2026-07-16T15:59:59.819431+00:00",
				},
				seven_day_opus: null,
				limits: [],
				extra_usage: { is_enabled: false },
			};
			const fetchImpl = vi.fn(async () => Response.json(body));

			const result = await fetchClaudeOauthUsage({
				fetchImpl: fetchImpl as unknown as typeof fetch,
			});

			expect(result).toMatchObject({
				five_hour: { utilization: 21.0 },
				seven_day: { utilization: 62.0 },
			});
			const [url, init] = fetchImpl.mock.calls[0] as unknown as [
				string,
				RequestInit,
			];
			expect(url).toBe("https://api.anthropic.com/api/oauth/usage");
			expect(new Headers(init.headers).get("Authorization")).toBe(
				"Bearer sk-ant-oat01-env-token",
			);
			expect(new Headers(init.headers).get("anthropic-beta")).toBe(
				"oauth-2025-04-20",
			);
		}));

	it("resolves null on a non-2xx response instead of throwing", () =>
		withEnvToken(async () => {
			const fetchImpl = vi.fn(
				async () => new Response("unauthorized", { status: 401 }),
			);
			await expect(
				fetchClaudeOauthUsage({
					fetchImpl: fetchImpl as unknown as typeof fetch,
				}),
			).resolves.toBeNull();
		}));

	it("resolves null on a network error instead of throwing", () =>
		withEnvToken(async () => {
			const fetchImpl = vi.fn(async () => {
				throw new Error("getaddrinfo ENOTFOUND api.anthropic.com");
			});
			await expect(
				fetchClaudeOauthUsage({
					fetchImpl: fetchImpl as unknown as typeof fetch,
				}),
			).resolves.toBeNull();
		}));
});
