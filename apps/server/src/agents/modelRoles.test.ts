import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "../db";
import { primeCustomProviders, setCustomProvider } from "./customProviders";
import {
	clearModelRole,
	getModelRole,
	listModelRoles,
	primeModelRolesFromDb,
	resolveModelChoice,
	resolveModelRole,
	setModelRole,
} from "./modelRoles";
import {
	effectiveModel,
	effectiveProvider,
	getOverride,
	primeOverrideFromDb,
} from "./providerConfigStore";
import {
	clearProviderApiKey,
	primeProviderCredentials,
	setProviderApiKey,
} from "./providerCredentials";

let dataDir: string;
const ENV_KEYS = [
	"DILNA_DATA_DIR",
	"DILNA_PROVIDER",
	"DILNA_MODEL",
	"ANTHROPIC_API_KEY",
	"DEEPSEEK_API_KEY",
] as const;
let oldEnv: Record<string, string | undefined>;

beforeEach(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-model-roles-"));
	oldEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	process.env.DILNA_DATA_DIR = dataDir;
	process.env.DILNA_PROVIDER = "anthropic";
	process.env.DILNA_MODEL = "claude-opus-4-5";
	process.env.ANTHROPIC_API_KEY = "sk-anthropic";
	process.env.DEEPSEEK_API_KEY = "sk-deepseek";
	primeCustomProviders();
	primeProviderCredentials();
	primeOverrideFromDb();
	primeModelRolesFromDb();
});

afterEach(() => {
	closeDb();
	for (const [k, v] of Object.entries(oldEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(dataDir, { recursive: true, force: true });
});

describe("model roles (issue #308)", () => {
	it("is unset by default, and unset resolves to 'not configured'", async () => {
		expect(getModelRole("cheap")).toBeNull();
		expect(listModelRoles()).toEqual({ cheap: null });
		expect(await resolveModelRole("cheap")).toEqual({ status: "unset" });
	});

	it("sets a builtin pair, resolves it, and persists across a restart", async () => {
		const result = await setModelRole("cheap", "deepseek", "deepseek-flash");
		expect(result).toEqual({ ok: true });
		expect(await resolveModelRole("cheap")).toEqual({
			status: "resolved",
			provider: "deepseek",
			model: "deepseek-flash",
		});

		// A fresh boot reads it back from SQLite, not from the process cache.
		closeDb();
		primeModelRolesFromDb();
		expect(getModelRole("cheap")).toEqual({
			provider: "deepseek",
			model: "deepseek-flash",
		});
	});

	it("accepts a custom provider's model", async () => {
		setCustomProvider({
			id: "local",
			name: "Local",
			baseUrl: "http://localhost:11434/v1",
			api: "openai-completions",
			models: [{ id: "qwen3" }],
		});
		setProviderApiKey("local", "sk-local");
		expect(await setModelRole("cheap", "local", "qwen3")).toEqual({
			ok: true,
		});
		expect((await resolveModelRole("cheap")).status).toBe("resolved");
	});

	it("rejects invalid combinations up front with an actionable error", async () => {
		const unknownProvider = await setModelRole("cheap", "nope", "x");
		expect(unknownProvider.ok).toBe(false);
		const unknownModel = await setModelRole("cheap", "deepseek", "gpt-9");
		expect(unknownModel).toEqual({
			ok: false,
			error: expect.stringContaining("not a known model"),
		});
		delete process.env.DEEPSEEK_API_KEY;
		const noKey = await setModelRole("cheap", "deepseek", "deepseek-flash");
		expect(noKey).toEqual({
			ok: false,
			error: expect.stringContaining("No API key"),
		});
		expect(getModelRole("cheap")).toBeNull();
	});

	it("clears a role", async () => {
		await setModelRole("cheap", "deepseek", "deepseek-flash");
		clearModelRole("cheap");
		expect(await resolveModelRole("cheap")).toEqual({ status: "unset" });
		primeModelRolesFromDb();
		expect(getModelRole("cheap")).toBeNull();
	});

	it("re-validates at execution time: a key removed after setting makes the role invalid", async () => {
		setProviderApiKey("deepseek", "sk-stored");
		delete process.env.DEEPSEEK_API_KEY;
		await setModelRole("cheap", "deepseek", "deepseek-flash");
		clearProviderApiKey("deepseek");

		const resolution = await resolveModelRole("cheap");
		expect(resolution).toEqual({
			status: "invalid",
			error: expect.stringMatching(/"cheap" model role.*Settings/),
		});
	});

	it("leaves the instance override untouched — roles change nothing else", async () => {
		await setModelRole("cheap", "deepseek", "deepseek-flash");
		expect(getOverride()).toBeNull();
		expect(effectiveProvider()).toBe("anthropic");
		expect(effectiveModel()).toBe("claude-opus-4-5");
		primeOverrideFromDb();
		expect(getOverride()).toBeNull();
	});
});

describe("resolveModelChoice (issues #309/#310)", () => {
	it("resolves a configured role name to its current pair", async () => {
		await setModelRole("cheap", "deepseek", "deepseek-flash");
		expect(await resolveModelChoice(" cheap ")).toEqual({
			status: "resolved",
			provider: "deepseek",
			model: "deepseek-flash",
			role: "cheap",
		});
	});

	it("reports an unset role so the caller can fall back", async () => {
		expect(await resolveModelChoice("cheap")).toEqual({
			status: "unset-role",
			role: "cheap",
		});
	});

	it("accepts a concrete pair, splitting on the first slash", async () => {
		expect(await resolveModelChoice("anthropic/claude-opus-4-5")).toEqual({
			status: "resolved",
			provider: "anthropic",
			model: "claude-opus-4-5",
			role: null,
		});
	});

	it("rejects unknown roles and invalid pairs with actionable messages", async () => {
		expect(await resolveModelChoice("expensive")).toEqual({
			status: "invalid",
			error: expect.stringMatching(/not a model role.*Known roles: cheap/),
		});
		expect(await resolveModelChoice("deepseek/gpt-9")).toEqual({
			status: "invalid",
			error: expect.stringMatching(/not a known model.*model role/),
		});
	});
});
