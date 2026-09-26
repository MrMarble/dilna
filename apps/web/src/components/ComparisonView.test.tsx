import type { ComparisonResponse } from "@dilna/shared";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ComparisonView as ComparisonData } from "@/api/client";
import { ComparisonView } from "@/components/ComparisonView";
import type { PartialApi } from "@/test/api-mock";
import { makeSession } from "@/test/factories";

// Mutable fixture state lives inside vi.hoisted so the vi.mock factory (also
// hoisted) can reach it — the same pattern SettingsPage.test.tsx uses.
const state = vi.hoisted(() => ({
	current: null as ComparisonData | null,
	// What the ChatShell stub received, per render.
	rendered: [] as { sessionId: string; composer: "pill" | "none" }[],
}));

// ChatShell is heavy (SSE hub, transcript fetch, stream reducer) and already
// tested on its own. What's under test here is the comparison view's contract
// — column layout, which arms are visible, and what sits on the composer —
// so stub it with a component that reports the props it received.
vi.mock("@/components/ChatShell", () => ({
	ChatShell: (props: {
		sessionId: string;
		composerHeader?: React.ReactNode;
	}) => {
		state.rendered.push({
			sessionId: props.sessionId,
			composer: props.composerHeader ? "pill" : "none",
		});
		// The pill renders for real — the pill-switch test clicks it.
		return (
			<div data-testid={`chat-${props.sessionId}`}>
				{props.composerHeader}
				stub for {props.sessionId}
			</div>
		);
	},
}));

vi.mock("@/api/client", () => ({
	api: {
		comparisons: {
			get: vi.fn(
				async (): Promise<ComparisonResponse> => ({
					comparison: state.current as ComparisonData,
				}),
			),
		},
		sessionList: {
			stream: vi.fn(() => () => {}),
		},
	} satisfies PartialApi,
}));

function makeComparison(): ComparisonData {
	return {
		id: "grp-1",
		repoId: "repo-1",
		createdAt: 1,
		sessions: [
			makeSession({ id: "arm-0", model: "claude-opus-4-5" }),
			makeSession({ id: "arm-1", model: "deepseek-chat" }),
		],
	};
}

async function renderView(isDesktop: boolean) {
	state.current = makeComparison();
	state.rendered = [];
	render(
		<ComparisonView
			groupId="grp-1"
			repos={[]}
			isDesktop={isDesktop}
			onBack={() => {}}
		/>,
	);
	// The comparison fetch resolves on a microtask; flush it.
	await screen.findByTestId("chat-arm-0");
}

// Tailwind visibility via class list — token membership, not a substring
// ("overflow-hidden" would false-positive).
function classNamesOf(el: Element | null | undefined): string[] {
	return (el?.className ?? "").split(/\s+/).filter(Boolean);
}

describe("ComparisonView (issue #250)", () => {
	it("renders every arm side by side on desktop, no pill on the composer", async () => {
		await renderView(true);

		expect(screen.getByTestId("chat-arm-0")).toBeInTheDocument();
		expect(screen.getByTestId("chat-arm-1")).toBeInTheDocument();
		// Per-column model labels.
		expect(screen.getByText("claude-opus-4-5")).toBeInTheDocument();
		expect(screen.getByText("deepseek-chat")).toBeInTheDocument();
		// Desktop composes per column — no mobile pill anywhere.
		expect(state.rendered.map((r) => r.composer)).toEqual(["none", "none"]);
	});

	it("mounts both arms but shows one at a time on mobile, pill on the composer", async () => {
		await renderView(false);

		// Both stay mounted (hidden, not unmounted — streams stay live), but
		// only the active column is visible.
		expect(screen.getByTestId("chat-arm-0")).toBeInTheDocument();
		expect(screen.getByTestId("chat-arm-1")).toBeInTheDocument();
		const colA = screen.getByTestId("chat-arm-0").parentElement;
		const colB = screen.getByTestId("chat-arm-1").parentElement;
		expect(classNamesOf(colA)).not.toContain("hidden");
		expect(classNamesOf(colB)).toContain("hidden");

		// The pill sits on top of the input box of every mobile column.
		expect(state.rendered.map((r) => r.composer)).toEqual(["pill", "pill"]);
	});

	it("switches the active arm from the pill", async () => {
		const user = userEvent.setup();
		await renderView(false);

		await user.click(
			within(
				screen.getByTestId("chat-arm-0").parentElement ?? document.body,
			).getByRole("tab", { name: "deepseek-chat" }),
		);

		const colA = screen.getByTestId("chat-arm-0").parentElement;
		const colB = screen.getByTestId("chat-arm-1").parentElement;
		expect(classNamesOf(colA)).toContain("hidden");
		expect(classNamesOf(colB)).not.toContain("hidden");
	});
});
