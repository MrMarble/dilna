import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LlmConfig } from "@/api/client";
import { ModelRolesSection } from "@/components/ModelRolesSection";
import type { PartialApi } from "@/test/api-mock";

const state = vi.hoisted(() => {
	function make(cheap: LlmConfig["roles"]["cheap"]): LlmConfig {
		return {
			override: null,
			envDefault: { provider: "anthropic", model: "claude-opus-4-5" },
			effective: { provider: "anthropic", model: "claude-opus-4-5" },
			apiKeysConfigured: { anthropic: true, deepseek: true },
			keyedStoredProviders: [],
			modelsByProvider: {
				anthropic: [{ id: "claude-opus-4-5", name: "Claude Opus 4.5" }],
				deepseek: [{ id: "deepseek-flash", name: "DeepSeek Flash" }],
			},
			oauthConnected: { anthropic: false },
			customProviders: [],
			roles: { cheap },
		};
	}
	const current = { value: make(null) };
	return { current, make };
});

const setModelRole = vi.fn(
	async (role: "cheap", provider: string, model: string) => {
		state.current.value = state.make({ provider, model });
		return { ok: true, role, assignment: { provider, model } };
	},
);
const clearModelRole = vi.fn(async (role: "cheap") => {
	state.current.value = state.make(null);
	return { ok: true, role, assignment: null };
});

vi.mock("@/api/client", () => ({
	api: {
		config: {
			get: async () => state.current.value,
			setModelRole: (...args: Parameters<typeof setModelRole>) =>
				setModelRole(...args),
			clearModelRole: (...args: Parameters<typeof clearModelRole>) =>
				clearModelRole(...args),
		},
	} satisfies PartialApi,
}));

beforeEach(() => {
	state.current.value = state.make(null);
	setModelRole.mockClear();
	clearModelRole.mockClear();
});

describe("ModelRolesSection (issue #308)", () => {
	it("assigns the cheap role from the keyed provider/model list", async () => {
		const onConfigChange = vi.fn();
		render(
			<ModelRolesSection
				config={state.current.value}
				onConfigChange={onConfigChange}
			/>,
		);
		const select = screen.getByLabelText("Cheap model");
		expect(select).toHaveValue("");
		// Nothing to clear while unset.
		expect(screen.getByRole("button", { name: /clear/i })).toBeDisabled();

		await userEvent.selectOptions(select, "deepseek/deepseek-flash");
		await userEvent.click(screen.getByRole("button", { name: /save role/i }));

		expect(setModelRole).toHaveBeenCalledWith(
			"cheap",
			"deepseek",
			"deepseek-flash",
		);
		expect(onConfigChange).toHaveBeenCalledWith(
			expect.objectContaining({
				roles: { cheap: { provider: "deepseek", model: "deepseek-flash" } },
			}),
		);
		expect(
			await screen.findByText(/cheap model is now deepseek\/deepseek-flash/),
		).toBeInTheDocument();
	});

	it("clears an assigned role", async () => {
		state.current.value = state.make({
			provider: "deepseek",
			model: "deepseek-flash",
		});
		render(
			<ModelRolesSection
				config={state.current.value}
				onConfigChange={() => {}}
			/>,
		);
		expect(screen.getByLabelText("Cheap model")).toHaveValue(
			"deepseek/deepseek-flash",
		);
		await userEvent.click(screen.getByRole("button", { name: /clear/i }));
		expect(clearModelRole).toHaveBeenCalledWith("cheap");
		expect(screen.getByLabelText("Cheap model")).toHaveValue("");
	});

	it("surfaces a rejected assignment inline", async () => {
		setModelRole.mockRejectedValueOnce(
			new Error('No API key configured for provider "deepseek"'),
		);
		render(
			<ModelRolesSection
				config={state.current.value}
				onConfigChange={() => {}}
			/>,
		);
		await userEvent.selectOptions(
			screen.getByLabelText("Cheap model"),
			"deepseek/deepseek-flash",
		);
		await userEvent.click(screen.getByRole("button", { name: /save role/i }));
		expect(
			await screen.findByText(/No API key configured/),
		).toBeInTheDocument();
	});
});
