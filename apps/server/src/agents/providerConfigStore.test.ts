import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "../db";
import { primeCustomProviders, setCustomProvider } from "./customProviders";
import {
	clearOverride,
	effectiveModel,
	effectiveProvider,
	getOverride,
	primeOverrideFromDb,
	setOverride,
} from "./providerConfigStore";
import {
	primeProviderCredentials,
	setProviderApiKey,
} from "./providerCredentials";

let dataDir: string;
let oldDataDir: string | undefined;
let oldProvider: string | undefined;
let oldModel: string | undefined;

/**
 * The store reads its persisted override from the same SQLite DB the rest of
 * the server uses (via getDb), so these tests set a throwaway DILNA_DATA_DIR
 * and reset the small module state (the in-memory override cache and the env
 * fallback) around each test.
 */
beforeEach(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-config-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	oldProvider = process.env.DILNA_PROVIDER;
	oldModel = process.env.DILNA_MODEL;
	process.env.DILNA_DATA_DIR = dataDir;
	process.env.DILNA_PROVIDER = "anthropic";
	process.env.DILNA_MODEL = "claude-opus-5";
	// Each allowlisted provider needs its matching key configured before an
	// override for it validates (see setOverride).
	process.env.ANTHROPIC_API_KEY = "sk-anthropic";
	process.env.DEEPSEEK_API_KEY = "sk-deepseek";
	process.env.MOONSHOT_API_KEY = "sk-moonshot";
	process.env.ZAI_API_KEY = "sk-zai";
	primeCustomProviders();
	primeProviderCredentials();
	// Fresh DB (each test gets its own dir) => no persisted override yet.
	primeOverrideFromDb();
});

afterEach(() => {
	closeDb();
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	if (oldProvider === undefined) delete process.env.DILNA_PROVIDER;
	else process.env.DILNA_PROVIDER = oldProvider;
	if (oldModel === undefined) delete process.env.DILNA_MODEL;
	else process.env.DILNA_MODEL = oldModel;
	rmSync(dataDir, { recursive: true, force: true });
});

describe("provider config override store", () => {
	it("starts with no override, so the effective provider/model is the env fallback", () => {
		expect(getOverride()).toBeNull();
		expect(effectiveProvider()).toBe("anthropic");
		expect(effectiveModel()).toBe("claude-opus-5");
	});

	it("persists a valid override and makes it take effect immediately", async () => {
		const res = await setOverride("deepseek", "deepseek-v4-flash");
		expect(res.ok).toBe(true);
		expect(effectiveProvider()).toBe("deepseek");
		expect(effectiveModel()).toBe("deepseek-v4-flash");
	});

	it("persists to the DB so it survives restart (override survives close/re-prime)", async () => {
		await setOverride("moonshotai", "kimi-k2.5");
		// Simulate a server restart: close the DB connection, then re-prime the
		// module cache from the on-disk row. The override must come back from
		// SQLite rather than from the module's in-memory cache.
		closeDb();
		primeOverrideFromDb();
		expect(effectiveProvider()).toBe("moonshotai");
		expect(effectiveModel()).toBe("kimi-k2.5");
	});

	it("clearing the override returns effective values to the env fallback", async () => {
		await setOverride("deepseek", "deepseek-v4-flash");
		clearOverride();
		expect(effectiveProvider()).toBe("anthropic");
		expect(effectiveModel()).toBe("claude-opus-5");
	});

	it("rejects a provider outside the allowlist", async () => {
		const res = await setOverride("kimi-coding", "k3");
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("unreachable");
		expect(res.error).toContain("not a supported provider");
		expect(getOverride()).toBeNull();
	});

	it("rejects a model not in the provider's catalog", async () => {
		const res = await setOverride("anthropic", "definitely-not-a-model");
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("unreachable");
		expect(res.error).toContain("not a known model");
		expect(getOverride()).toBeNull();
	});

	it("rejects when the matching API key env var is absent", async () => {
		delete process.env.DEEPSEEK_API_KEY;
		const res = await setOverride("deepseek", "deepseek-v4-flash");
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("unreachable");
		expect(res.error).toContain("No API key configured");
		expect(getOverride()).toBeNull();
	});

	it("setting an empty provider+model is rejected as nothing to set", async () => {
		const res = await setOverride("", "");
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("unreachable");
		expect(res.error).toContain("empty");
	});

	describe("custom providers", () => {
		beforeEach(() => {
			setCustomProvider({
				id: "ollama",
				name: "Ollama",
				baseUrl: "http://localhost:11434/v1",
				api: "openai-completions",
				models: [{ id: "llama3.1:8b" }],
			});
			setProviderApiKey("ollama", "sk-ollama");
		});

		it("accepts an override for a custom provider + one of its models", async () => {
			const res = await setOverride("ollama", "llama3.1:8b");
			expect(res.ok).toBe(true);
			expect(effectiveProvider()).toBe("ollama");
			expect(effectiveModel()).toBe("llama3.1:8b");
		});

		it("rejects a model id the custom provider doesn't have", async () => {
			const res = await setOverride("ollama", "not-a-real-model");
			expect(res.ok).toBe(false);
			if (res.ok) throw new Error("unreachable");
			expect(res.error).toContain("not a known model");
		});
	});
});
