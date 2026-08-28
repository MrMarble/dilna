import { describe, expect, it, vi } from "vitest";
import { PROVIDER_ALLOWLIST, validateProviderConfig } from "./providerConfig";

describe("validateProviderConfig", () => {
	it("passes for a valid provider/model/api-key combination", () => {
		const result = validateProviderConfig(
			{ DILNA_PROVIDER: "anthropic", DILNA_MODEL: "claude-opus-5" },
			{
				getBuiltinModels: () => [{ id: "claude-opus-5" } as never],
				getEnvApiKey: () => "sk-test",
			},
		);
		expect(result).toEqual({
			ok: true,
			provider: "anthropic",
			model: "claude-opus-5",
		});
	});

	it("fails with a specific message when DILNA_PROVIDER is unset", () => {
		const result = validateProviderConfig({});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("DILNA_PROVIDER is not set");
		for (const p of PROVIDER_ALLOWLIST) expect(result.error).toContain(p);
	});

	it("fails and names the four valid providers for a kimi-coding near-miss", () => {
		const getBuiltinModels = vi.fn();
		const result = validateProviderConfig(
			{ DILNA_PROVIDER: "kimi-coding", DILNA_MODEL: "k3" },
			{ getBuiltinModels },
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("kimi-coding");
		expect(result.error).toContain("anthropic, deepseek, moonshotai, zai");
		// The allowlist check must short-circuit before ever touching pi-ai's catalog.
		expect(getBuiltinModels).not.toHaveBeenCalled();
	});

	it("fails for an anthropic-cn-shaped near-miss", () => {
		const result = validateProviderConfig({
			DILNA_PROVIDER: "anthropic-cn",
			DILNA_MODEL: "whatever",
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("not a supported provider");
	});

	it("fails with a specific message when DILNA_MODEL is unset", () => {
		const result = validateProviderConfig(
			{ DILNA_PROVIDER: "anthropic" },
			{ getBuiltinModels: () => [] },
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("DILNA_MODEL is not set");
	});

	it("fails when the model isn't in the provider's catalog", () => {
		const result = validateProviderConfig(
			{ DILNA_PROVIDER: "anthropic", DILNA_MODEL: "not-a-real-model" },
			{ getBuiltinModels: () => [{ id: "claude-opus-5" } as never] },
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("not-a-real-model");
		expect(result.error).toContain("claude-opus-5");
	});

	it("fails when the matching API-key env var is missing", () => {
		const result = validateProviderConfig(
			{ DILNA_PROVIDER: "anthropic", DILNA_MODEL: "claude-opus-5" },
			{
				getBuiltinModels: () => [{ id: "claude-opus-5" } as never],
				getEnvApiKey: () => undefined,
			},
		);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("anthropic");
		expect(result.error).toContain("API key");
	});

	it("resolves the real pi-ai catalog for anthropic (no stubs)", () => {
		const result = validateProviderConfig({
			DILNA_PROVIDER: "anthropic",
			DILNA_MODEL: "claude-opus-5",
			ANTHROPIC_API_KEY: "sk-test",
		});
		expect(result).toEqual({
			ok: true,
			provider: "anthropic",
			model: "claude-opus-5",
		});
	});
});
