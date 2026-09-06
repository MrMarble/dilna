import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb } from "../db";
import {
	buildCustomModel,
	type CustomProvider,
	deleteCustomProvider,
	getCustomProvider,
	isCustomProvider,
	listCustomProviders,
	primeCustomProviders,
	setCustomProvider,
} from "./customProviders";

let dataDir: string;
let oldDataDir: string | undefined;

beforeEach(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-custom-providers-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;
	primeCustomProviders();
});

afterEach(() => {
	closeDb();
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
});

const ollama = {
	id: "ollama",
	name: "Ollama",
	baseUrl: "http://localhost:11434/v1",
	api: "openai-completions",
	models: [
		{ id: "llama3.1:8b", name: "Llama 3.1 8B" },
		{ id: "qwen2.5-coder:7b" },
	],
};

describe("setCustomProvider", () => {
	it("creates a new provider and lists it", () => {
		const res = setCustomProvider(ollama);
		expect(res.ok).toBe(true);
		expect(listCustomProviders()).toEqual([
			{
				id: "ollama",
				name: "Ollama",
				baseUrl: "http://localhost:11434/v1",
				api: "openai-completions",
				models: [
					{ id: "llama3.1:8b", name: "Llama 3.1 8B" },
					{ id: "qwen2.5-coder:7b", name: undefined },
				],
			},
		]);
		expect(isCustomProvider("ollama")).toBe(true);
	});

	it("updates in place when called again with the same id", () => {
		setCustomProvider(ollama);
		const res = setCustomProvider({ ...ollama, name: "Local Ollama" });
		expect(res.ok).toBe(true);
		expect(listCustomProviders()).toHaveLength(1);
		expect(getCustomProvider("ollama")?.name).toBe("Local Ollama");
	});

	it("survives a restart (persists to the DB, re-primed from disk)", () => {
		setCustomProvider(ollama);
		closeDb();
		primeCustomProviders();
		expect(getCustomProvider("ollama")).toMatchObject({ name: "Ollama" });
	});

	it("rejects an id that collides with a built-in provider", () => {
		const res = setCustomProvider({ ...ollama, id: "anthropic" });
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("unreachable");
		expect(res.error).toContain("already a built-in provider");
	});

	it("rejects an invalid id slug", () => {
		const res = setCustomProvider({ ...ollama, id: "Not Valid!" });
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("unreachable");
		expect(res.error).toContain("Provider ID");
	});

	it("rejects an unsupported api type", () => {
		const res = setCustomProvider({ ...ollama, api: "grpc" });
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("unreachable");
		expect(res.error).toContain("not a supported API type");
	});

	it("rejects an empty models list", () => {
		const res = setCustomProvider({ ...ollama, models: [] });
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("unreachable");
		expect(res.error).toContain("at least one model");
	});

	it("rejects duplicate model ids", () => {
		const res = setCustomProvider({
			...ollama,
			models: [{ id: "llama3.1:8b" }, { id: "llama3.1:8b" }],
		});
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("unreachable");
		expect(res.error).toContain("Duplicate model ID");
	});
});

describe("deleteCustomProvider", () => {
	it("removes the provider and calls the clearApiKey callback with its id", () => {
		setCustomProvider(ollama);
		const clearApiKey = vi.fn();
		deleteCustomProvider("ollama", clearApiKey);
		expect(getCustomProvider("ollama")).toBeUndefined();
		expect(clearApiKey).toHaveBeenCalledWith("ollama");
	});
});

describe("buildCustomModel", () => {
	const provider: CustomProvider = {
		id: "ollama",
		name: "Ollama",
		baseUrl: "http://localhost:11434/v1",
		api: "openai-completions",
		models: [{ id: "llama3.1:8b", name: "Llama 3.1 8B" }, { id: "bare-model" }],
	};

	it("fills in models.json-style defaults for a named model", () => {
		expect(buildCustomModel(provider, "llama3.1:8b")).toEqual({
			id: "llama3.1:8b",
			name: "Llama 3.1 8B",
			api: "openai-completions",
			provider: "ollama",
			baseUrl: "http://localhost:11434/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		});
	});

	it("falls back to the model id as the display name when none is set", () => {
		expect(buildCustomModel(provider, "bare-model")?.name).toBe("bare-model");
	});

	it("returns undefined for an unknown model id", () => {
		expect(buildCustomModel(provider, "nope")).toBeUndefined();
	});
});
