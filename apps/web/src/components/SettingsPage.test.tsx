import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CustomProviderView, LlmConfig } from "@/api/client";
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
			modelsByProvider: { ...models },
			oauthConnected: { anthropic: false },
			customProviders: [],
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
			// Minimal stand-in for the server's custom-provider routes: enough to
			// verify the create/delete flow reaches the UI, not a full validation
			// re-implementation (that's covered server-side).
			createCustomProvider: (input: CustomProviderView) => {
				current.value.customProviders = [
					...current.value.customProviders,
					input,
				];
				current.value.modelsByProvider[input.id] = input.models.map((m) => ({
					id: m.id,
					name: m.name ?? m.id,
				}));
				current.value.apiKeysConfigured[input.id] = true;
				return { ok: true };
			},
			deleteCustomProvider: (id: string) => {
				current.value.customProviders = current.value.customProviders.filter(
					(p) => p.id !== id,
				);
				delete current.value.modelsByProvider[id];
				return { ok: true };
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
			startAnthropicOAuthLogin: vi.fn(async () => ({
				loginId: "test-login",
				authUrl: "https://claude.ai/oauth/authorize?test=1",
			})),
			completeAnthropicOAuthLogin: vi.fn(async () => ({ ok: true })),
			cancelAnthropicOAuthLogin: vi.fn(async () => ({ ok: true })),
			disconnectAnthropicOAuth: vi.fn(async () => ({ ok: true })),
			createCustomProvider: vi.fn(async (input: CustomProviderView) =>
				state.api.createCustomProvider(input),
			),
			updateCustomProvider: vi.fn(async () => ({ ok: true })),
			deleteCustomProvider: vi.fn(async (id: string) =>
				state.api.deleteCustomProvider(id),
			),
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

	describe("custom providers", () => {
		it("adds a custom provider and shows it in the management list and provider dropdown", async () => {
			state.reset();
			const user = userEvent.setup();
			render(<SettingsPage onBack={() => {}} />);
			await screen.findByText(/currently in effect/i);

			await user.click(
				screen.getByRole("button", { name: /add custom provider/i }),
			);
			await user.type(screen.getByLabelText("Provider ID"), "ollama");
			await user.type(screen.getByLabelText("Name"), "Ollama");
			await user.type(
				screen.getByLabelText("Base URL"),
				"http://localhost:11434/v1",
			);
			await user.type(screen.getByPlaceholderText(/model id/i), "llama3.1:8b");
			await user.click(screen.getByRole("button", { name: /add provider/i }));

			expect(
				await screen.findByText(/custom provider added/i),
			).toBeInTheDocument();
			// Appears both as a management-list row and a provider dropdown option.
			expect(screen.getAllByText("ollama").length).toBeGreaterThanOrEqual(2);
			expect(
				screen.getByRole("option", { name: /^ollama/ }),
			).toBeInTheDocument();
		});

		it("removes a custom provider from the management list", async () => {
			state.reset();
			state.api.createCustomProvider({
				id: "ollama",
				name: "Ollama",
				baseUrl: "http://localhost:11434/v1",
				api: "openai-completions",
				models: [{ id: "llama3.1:8b" }],
			});
			const user = userEvent.setup();
			render(<SettingsPage onBack={() => {}} />);
			await screen.findByRole("button", { name: /remove ollama/i });

			await user.click(screen.getByRole("button", { name: /remove ollama/i }));

			expect(
				await screen.findByText(/removed custom provider/i),
			).toBeInTheDocument();
			// The management-list row is gone; the dropdown option may briefly
			// linger until the refetch resolves, so check the row specifically.
			expect(
				screen.queryByRole("button", { name: /remove ollama/i }),
			).not.toBeInTheDocument();
		});
	});
});
