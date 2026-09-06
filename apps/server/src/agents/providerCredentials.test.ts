import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb } from "../db";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));

vi.mock("@earendil-works/pi-ai/providers/anthropic", () => ({
	anthropicProvider: () => ({
		auth: {
			oauth: {
				name: "Anthropic (Claude Pro/Max)",
				isSubscription: true,
				login: vi.fn(),
				refresh,
				toAuth: async (credential: OAuthCredential) => ({
					apiKey: credential.access,
				}),
			},
		},
	}),
}));

const {
	clearProviderApiKey,
	clearProviderOAuthCredential,
	hasApiKey,
	hasOAuthCredential,
	primeProviderCredentials,
	resolveApiKey,
	setProviderApiKey,
	setProviderOAuthCredential,
} = await import("./providerCredentials");

let dataDir: string;
let oldDataDir: string | undefined;
let oldAnthropicKey: string | undefined;

function oauthCredential(
	overrides: Partial<OAuthCredential> = {},
): OAuthCredential {
	return {
		type: "oauth",
		access: "sk-ant-oat-access-token",
		refresh: "sk-ant-ort-refresh-token",
		expires: Date.now() + 60 * 60 * 1000,
		...overrides,
	};
}

beforeEach(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-credentials-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	oldAnthropicKey = process.env.ANTHROPIC_API_KEY;
	process.env.DILNA_DATA_DIR = dataDir;
	delete process.env.ANTHROPIC_API_KEY;
	refresh.mockReset();
	primeProviderCredentials();
});

afterEach(() => {
	closeDb();
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	if (oldAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
	else process.env.ANTHROPIC_API_KEY = oldAnthropicKey;
	rmSync(dataDir, { recursive: true, force: true });
});

describe("resolveApiKey", () => {
	it("falls back through stored key then env when nothing is connected", async () => {
		expect(await resolveApiKey("anthropic")).toBeUndefined();

		process.env.ANTHROPIC_API_KEY = "sk-env-key";
		expect(await resolveApiKey("anthropic")).toBe("sk-env-key");

		setProviderApiKey("anthropic", "sk-stored-key");
		expect(await resolveApiKey("anthropic")).toBe("sk-stored-key");
	});

	it("prefers a connected OAuth login over a stored API key", async () => {
		setProviderApiKey("anthropic", "sk-stored-key");
		setProviderOAuthCredential("anthropic", oauthCredential());

		expect(await resolveApiKey("anthropic")).toBe("sk-ant-oat-access-token");
		expect(await hasOAuthCredential("anthropic")).toBe(true);
		expect(refresh).not.toHaveBeenCalled();
	});

	it("refreshes a token nearing expiry and persists the rotated credential", async () => {
		setProviderOAuthCredential(
			"anthropic",
			oauthCredential({ expires: Date.now() + 60 * 1000 }),
		);
		refresh.mockResolvedValue(
			oauthCredential({
				access: "sk-ant-oat-refreshed",
				refresh: "sk-ant-ort-refreshed",
				expires: Date.now() + 60 * 60 * 1000,
			}),
		);

		expect(await resolveApiKey("anthropic")).toBe("sk-ant-oat-refreshed");
		expect(refresh).toHaveBeenCalledTimes(1);

		// Rotated credential was persisted — a second read doesn't refresh again.
		refresh.mockClear();
		expect(await resolveApiKey("anthropic")).toBe("sk-ant-oat-refreshed");
		expect(refresh).not.toHaveBeenCalled();
	});

	it("falls back to the stale access token when refresh fails, without throwing", async () => {
		setProviderApiKey("anthropic", "sk-stored-key");
		setProviderOAuthCredential(
			"anthropic",
			oauthCredential({ expires: Date.now() + 60 * 1000 }),
		);
		refresh.mockRejectedValue(new Error("invalid_grant"));

		await expect(resolveApiKey("anthropic")).resolves.toBe(
			"sk-ant-oat-access-token",
		);
	});

	it("disconnecting OAuth falls back to the stored key, then env", async () => {
		setProviderApiKey("anthropic", "sk-stored-key");
		setProviderOAuthCredential("anthropic", oauthCredential());
		clearProviderOAuthCredential("anthropic");

		expect(await resolveApiKey("anthropic")).toBe("sk-stored-key");
		expect(await hasOAuthCredential("anthropic")).toBe(false);

		clearProviderApiKey("anthropic");
		expect(await resolveApiKey("anthropic")).toBeUndefined();
	});

	it("hasApiKey reflects any usable credential, including OAuth", async () => {
		expect(await hasApiKey("anthropic")).toBe(false);
		setProviderOAuthCredential("anthropic", oauthCredential());
		expect(await hasApiKey("anthropic")).toBe(true);
	});
});
