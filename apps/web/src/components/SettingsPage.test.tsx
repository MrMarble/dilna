import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { LlmConfig } from "@/api/client";
import { SettingsPage } from "@/components/SettingsPage";

// Mutable fixture state lives inside vi.hoisted so the vi.mock factory (also
// hoisted) can reach it — vi.mock factories are evaluated before ordinary
// top-level declarations, so referencing a normal `let` would throw a TDZ
// error. Each test calls `reset()` to start from a no-override config.
const state = vi.hoisted(() => {
	const models = {
		anthropic: [
			{ id: "claude-opus-4-5", name: "Claude Opus 4.5" },
			{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
		],
		deepseek: [{ id: "deepseek-v4-flash", name: "DeepSeek V4 Flash" }],
	} as unknown as LlmConfig["modelsByProvider"];

	function make(over: LlmConfig["override"]): LlmConfig {
		return {
			override: over,
			envDefault: { provider: "anthropic", model: "claude-opus-4-5" },
			effective: over
				? over
				: { provider: "anthropic", model: "claude-opus-4-5" },
			apiKeysConfigured: { anthropic: true, deepseek: false },
			keyedStoredProviders: [],
			modelsByProvider: models,
		};
	}

	const current = { value: make(null) };
	return {
		// Seed each test: start with no override (env fallback in effect).
		reset: () => {
			current.value = make(null);
		},
		setOverrideConfig: (over: LlmConfig["override"]) => {
			current.value = make(over);
		},
		// API surface the component talks to — mirrors /api/config on the
		// server, including its "reject a provider with no API key" rule.
		api: {
			get: () => ({ ...current.value }),
			setOverride: (provider: string, model: string) => {
				if (!current.value.apiKeysConfigured[provider]) {
					throw new Error(`No API key configured for provider "${provider}".`);
				}
				current.value = make({ provider, model });
				return { ok: true, override: { provider, model } };
			},
			clearOverride: () => {
				current.value = make(null);
				return { ok: true, override: null };
			},
		},
	};
});

vi.mock("@/api/client", () => ({
	api: {
		config: {
			get: vi.fn(async () => state.api.get()),
			setOverride: vi.fn(async (p: string, m: string) =>
				state.api.setOverride(p, m),
			),
			clearOverride: vi.fn(async () => state.api.clearOverride()),
			setCredential: vi.fn(async () => ({ ok: true })),
			deleteCredential: vi.fn(async () => ({ ok: true })),
		},
	},
}));

describe("SettingsPage", () => {
	it("loads and shows the currently-in-effect provider/model", async () => {
		state.reset();
		render(<SettingsPage onBack={() => {}} />);
		expect(await screen.findByText(/currently in effect/i)).toBeInTheDocument();
		// Form is prefilled from the env default (no override yet).
		expect(screen.getByLabelText("Provider")).toHaveValue("anthropic");
		expect(screen.getByLabelText("Model")).toHaveValue("claude-opus-4-5");
		expect(screen.getByText(/from env/i)).toBeInTheDocument();
	});

	it("labels an existing override and flags a provider without an API key", async () => {
		state.reset();
		state.setOverrideConfig({
			provider: "deepseek",
			model: "deepseek-v4-flash",
		});
		render(<SettingsPage onBack={() => {}} />);
		await screen.findByText(/override set/i);
		// Appears in both the "currently in effect" summary and the model
		// dropdown's selected option.
		expect(screen.getAllByText(/deepseek-v4-flash/).length).toBeGreaterThan(0);
		expect(screen.getByLabelText("Provider")).toHaveValue("deepseek");
		expect(
			screen.getByText(/no api key is configured in the environment/i),
		).toBeInTheDocument();
	});

	it("save persists an override and confirms", async () => {
		state.reset();
		const user = userEvent.setup();
		render(<SettingsPage onBack={() => {}} />);
		await screen.findByText(/currently in effect/i);

		await user.selectOptions(
			screen.getByLabelText("Model"),
			"claude-haiku-4-5",
		);
		await user.click(
			screen.getByRole("button", { name: /save provider\/model/i }),
		);

		expect(state.api.get().override).toEqual({
			provider: "anthropic",
			model: "claude-haiku-4-5",
		});
		expect(
			await screen.findByText(/new sessions will use this provider\/model/i),
		).toBeInTheDocument();
		// After the refetch the override badge shows.
		expect(screen.getByText(/override set/i)).toBeInTheDocument();
	});

	it("surfaces the server validation error when saving a provider with no key", async () => {
		state.reset();
		const user = userEvent.setup();
		render(<SettingsPage onBack={() => {}} />);
		await screen.findByText(/currently in effect/i);
		await user.selectOptions(screen.getByLabelText("Provider"), "deepseek");
		await user.click(
			screen.getByRole("button", { name: /save provider\/model/i }),
		);
		expect(
			await screen.findByText(/no api key configured for provider/i),
		).toBeInTheDocument();
	});

	it("disables the env-default reset while no override is set", async () => {
		state.reset();
		render(<SettingsPage onBack={() => {}} />);
		await screen.findByText(/currently in effect/i);
		expect(
			screen.getByRole("button", { name: /use env default/i }),
		).toBeDisabled();
	});
});
