import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { useRoute } from "@/hooks/useRoute";
import type { Route } from "@/lib/routes";

/** Renders the current route as text and exposes buttons that navigate, so a
 * test can assert on both halves of the contract at once: what the address
 * bar says and what the component actually renders. */
function Harness({ links }: { links: Array<{ label: string; to: Route }> }) {
	const { route, navigate } = useRoute();
	return (
		<>
			<output data-testid="route">{JSON.stringify(route)}</output>
			{links.map((link) => (
				<button
					key={link.label}
					type="button"
					onClick={() => navigate(link.to)}
				>
					{link.label}
				</button>
			))}
			<button
				type="button"
				onClick={() => navigate({ kind: "home" }, { replace: true })}
			>
				replace with home
			</button>
		</>
	);
}

function currentRoute(): Route {
	return JSON.parse(screen.getByTestId("route").textContent ?? "null");
}

const METRICS: Route = { kind: "metrics" };
const SETTINGS: Route = { kind: "settings" };
const SESSION: Route = {
	kind: "repo",
	repoSlug: "dilna",
	sessionId: "sess-1",
};
const ORCHESTRATOR: Route = { kind: "orchestrator", sessionId: "orc-1" };

const LINKS = [
	{ label: "metrics", to: METRICS },
	{ label: "settings", to: SETTINGS },
	{ label: "session", to: SESSION },
	{ label: "orchestrator", to: ORCHESTRATOR },
];

describe("useRoute", () => {
	beforeEach(() => {
		window.history.replaceState(null, "", "/");
	});

	it("starts from the current address bar, so deep links land on the right view", () => {
		window.history.replaceState(null, "", "/dilna/sess-1");
		render(<Harness links={LINKS} />);
		expect(currentRoute()).toEqual(SESSION);
	});

	it("hydrates a deep-linked orchestrator chat", () => {
		window.history.replaceState(null, "", "/orchestrator/orc-1");
		render(<Harness links={LINKS} />);
		expect(currentRoute()).toEqual(ORCHESTRATOR);
	});

	it("updates both the URL and the rendered route when navigating", async () => {
		const user = userEvent.setup();
		render(<Harness links={LINKS} />);

		await user.click(screen.getByRole("button", { name: "metrics" }));
		expect(window.location.pathname).toBe("/metrics");
		expect(currentRoute()).toEqual(METRICS);

		await user.click(screen.getByRole("button", { name: "orchestrator" }));
		expect(window.location.pathname).toBe("/orchestrator/orc-1");
		expect(currentRoute()).toEqual(ORCHESTRATOR);
	});

	it("navigates away from a standalone view like any other route (no overlay trap)", async () => {
		const user = userEvent.setup();
		render(<Harness links={LINKS} />);

		await user.click(screen.getByRole("button", { name: "settings" }));
		expect(currentRoute()).toEqual(SETTINGS);

		// The regression: with Settings held in separate `view` state, this
		// click changed the selection but left the overlay up.
		await user.click(screen.getByRole("button", { name: "session" }));
		expect(currentRoute()).toEqual(SESSION);
		expect(window.location.pathname).toBe("/dilna/sess-1");
	});

	it("follows browser back/forward", async () => {
		const user = userEvent.setup();
		render(<Harness links={LINKS} />);

		await user.click(screen.getByRole("button", { name: "session" }));
		await user.click(screen.getByRole("button", { name: "metrics" }));
		expect(currentRoute()).toEqual(METRICS);

		await act(async () => {
			window.history.back();
			// happy-dom applies the history entry asynchronously and fires
			// popstate off a microtask, so let it drain before asserting.
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(currentRoute()).toEqual(SESSION);

		await act(async () => {
			window.history.forward();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(currentRoute()).toEqual(METRICS);
	});

	it("replace: true doesn't leave the replaced entry in history", async () => {
		const user = userEvent.setup();
		render(<Harness links={LINKS} />);

		await user.click(screen.getByRole("button", { name: "session" }));
		await user.click(screen.getByRole("button", { name: "metrics" }));
		await user.click(screen.getByRole("button", { name: "replace with home" }));
		expect(window.location.pathname).toBe("/");

		// Back skips the replaced /metrics entry and returns to the session.
		await act(async () => {
			window.history.back();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(currentRoute()).toEqual(SESSION);
	});

	it("doesn't stack a duplicate history entry for the path already showing", async () => {
		const user = userEvent.setup();
		render(<Harness links={LINKS} />);

		await user.click(screen.getByRole("button", { name: "session" }));
		await user.click(screen.getByRole("button", { name: "metrics" }));
		await user.click(screen.getByRole("button", { name: "metrics" }));

		// One "back" is enough to leave metrics, because the second click
		// pushed nothing.
		await act(async () => {
			window.history.back();
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		expect(currentRoute()).toEqual(SESSION);
	});
});
