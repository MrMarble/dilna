import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ComparisonView, LlmConfig } from "@/api/client";
import { NewComparisonDialog } from "@/components/NewComparisonDialog";
import type { PartialApi } from "@/test/api-mock";
import { makeRepo } from "@/test/factories";

const state = vi.hoisted(() => ({
	created: [] as unknown[],
	workspace: null as string | null,
	config: {} as LlmConfig,
}));

vi.mock("@/api/client", () => ({
	api: {
		config: {
			get: vi.fn(async () => state.config),
		},
		repos: {
			createWorkspace: vi.fn(async (input: { name: string }) => {
				state.workspace = input.name;
				return {
					repo: makeRepo({ id: "repo-new", slug: input.name, remoteUrl: "" }),
				};
			}),
		},
		comparisons: {
			create: vi.fn(async (input: unknown) => {
				state.created.push(input);
				return {
					comparison: {
						id: "grp-1",
						repoId: "repo-1",
						createdAt: 1,
						sessions: [],
					} as ComparisonView,
				};
			}),
		},
	} satisfies PartialApi,
}));

// Two keyed providers, so the dialog prefills two different models — the
// cross-provider A/B case the feature exists for.
state.config = {
	override: null,
	envDefault: { provider: "", model: "" },
	effective: { provider: "", model: "" },
	apiKeysConfigured: { anthropic: true, deepseek: true },
	keyedStoredProviders: [],
	modelsByProvider: {
		anthropic: [{ id: "claude-opus-4-5", name: "Claude Opus 4.5" }],
		deepseek: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
	},
	oauthConnected: { anthropic: false },
	customProviders: [],
};

async function renderDialog(onCreated: (c: ComparisonView) => void) {
	state.created = [];
	state.workspace = null;
	render(
		<NewComparisonDialog
			open
			onOpenChange={() => {}}
			repos={[makeRepo({ id: "repo-1", slug: "dilna" })]}
			onCreated={onCreated}
		/>,
	);
	await screen.findByLabelText("Initial prompt");
}

function filled() {
	return {
		repoId: "repo-1",
		prompt: "Explain the build system.",
		models: [
			{ provider: "anthropic", model: "claude-opus-4-5" },
			{ provider: "deepseek", model: "deepseek-chat" },
		],
	};
}

describe("NewComparisonDialog (issue #250)", () => {
	it("prefills the two arms with different keyed providers and submits the fan-out", async () => {
		const user = userEvent.setup();
		const onCreated = vi.fn();
		await renderDialog(onCreated);

		await user.selectOptions(screen.getByLabelText("Repository"), "repo-1");
		expect(screen.getByLabelText("Model A")).toHaveValue(
			"anthropic:claude-opus-4-5",
		);
		expect(screen.getByLabelText("Model B")).toHaveValue(
			"deepseek:deepseek-chat",
		);

		await user.type(
			screen.getByLabelText("Initial prompt"),
			"Explain the build system.",
		);
		await user.click(screen.getByRole("button", { name: "Start comparison" }));

		// The submit resolves through two awaited fetches; wait it out.
		await waitFor(() => expect(onCreated).toHaveBeenCalled());
		expect(state.created).toEqual([filled()]);
	});

	it("rejects the submit while the prompt is empty", async () => {
		await renderDialog(vi.fn());

		expect(
			screen.getByRole("button", { name: "Start comparison" }),
		).toBeDisabled();
		expect(state.created).toEqual([]);
	});
	it("mints a workspace first when the dropdown's new-workspace option is chosen", async () => {
		const user = userEvent.setup();
		const onCreated = vi.fn();
		await renderDialog(onCreated);

		await user.selectOptions(
			screen.getByLabelText("Repository"),
			"__workspace__",
		);
		const name = screen.getByLabelText("Workspace name");
		await user.type(name, "my-workspace");
		await user.type(
			screen.getByLabelText("Initial prompt"),
			"Explain the build system.",
		);
		await user.click(screen.getByRole("button", { name: "Start comparison" }));

		await waitFor(() => expect(onCreated).toHaveBeenCalled());
		expect(state.workspace).toBe("my-workspace");
		expect(state.created).toEqual([{ ...filled(), repoId: "repo-new" }]);
	});
});
