import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Drawer, DrawerContent } from "@/components/ui/drawer";
import { useMobileSheet } from "@/hooks/useMobileSheet";

/**
 * Exercises the exact composition App.tsx uses to wire the mobile header's
 * menu/files icons to the shared bottom sheet (issue #12's testing decision:
 * "tapping each icon renders the right content; tapping the already-active
 * icon's toggle closes it; tapping the other icon swaps content in place").
 * App itself pulls in the full API/data layer, so this harness swaps in
 * minimal stand-in content for the real Sidebar/ContextPanel — both already
 * covered by their own tests — while using the real `useMobileSheet` hook
 * and `Drawer`/`DrawerContent` primitives.
 */
function Harness() {
	const mobileSheet = useMobileSheet();
	return (
		<>
			<button
				ref={mobileSheet.menuTrigger.ref}
				type="button"
				onClick={mobileSheet.menuTrigger.onToggle}
			>
				Toggle menu
			</button>
			<button
				ref={mobileSheet.filesTrigger.ref}
				type="button"
				onClick={mobileSheet.filesTrigger.onToggle}
			>
				Toggle changed files
			</button>
			<Drawer
				open={mobileSheet.active !== null}
				onOpenChange={(open) => {
					if (!open) mobileSheet.close();
				}}
			>
				<DrawerContent finalFocus={mobileSheet.finalFocusRef}>
					{mobileSheet.active === "menu" && <div>Repos &amp; Sessions</div>}
					{mobileSheet.active === "files" && <div>Changed files content</div>}
				</DrawerContent>
			</Drawer>
		</>
	);
}

describe("mobile bottom sheet (App.tsx composition)", () => {
	it("renders nothing open initially", () => {
		render(<Harness />);
		expect(screen.queryByText("Repos & Sessions")).not.toBeInTheDocument();
		expect(screen.queryByText("Changed files content")).not.toBeInTheDocument();
	});

	it("tapping the menu icon renders the menu content", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		await user.click(screen.getByRole("button", { name: "Toggle menu" }));
		expect(screen.getByText("Repos & Sessions")).toBeInTheDocument();
		expect(screen.queryByText("Changed files content")).not.toBeInTheDocument();
	});

	it("tapping the files icon renders the files content", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		await user.click(
			screen.getByRole("button", { name: "Toggle changed files" }),
		);
		expect(screen.getByText("Changed files content")).toBeInTheDocument();
		expect(screen.queryByText("Repos & Sessions")).not.toBeInTheDocument();
	});

	it("tapping the already-open icon's toggle closes the sheet", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		const menuButton = screen.getByRole("button", { name: "Toggle menu" });
		await user.click(menuButton);
		expect(screen.getByText("Repos & Sessions")).toBeInTheDocument();
		await user.click(menuButton);
		expect(screen.queryByText("Repos & Sessions")).not.toBeInTheDocument();
	});

	it("tapping the other icon swaps content in place without stacking", async () => {
		const user = userEvent.setup();
		render(<Harness />);
		await user.click(screen.getByRole("button", { name: "Toggle menu" }));
		expect(screen.getByText("Repos & Sessions")).toBeInTheDocument();

		// Base UI's modal focus trap marks background content `inert` while
		// the sheet is open, which — same as the real header — puts the other
		// trigger outside the accessible tree; query with `hidden: true` to
		// reach it, matching the real app's header sitting visually above the
		// drawer (see ChatHeader/App's `z-[60]` header, verified by hand in a
		// real browser since jsdom/happy-dom's inert handling isn't identical).
		await user.click(
			screen.getByRole("button", {
				name: "Toggle changed files",
				hidden: true,
			}),
		);
		expect(screen.getByText("Changed files content")).toBeInTheDocument();
		expect(screen.queryByText("Repos & Sessions")).not.toBeInTheDocument();
		// Exactly one sheet is mounted throughout the swap — no stacking.
		expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1);
	});
});
