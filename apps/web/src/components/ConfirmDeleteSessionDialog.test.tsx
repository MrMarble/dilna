import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDeleteSessionDialog } from "@/components/ConfirmDeleteSessionDialog";
import { makeSession } from "@/test/factories";

describe("ConfirmDeleteSessionDialog", () => {
	it("renders nothing without a pending Session", () => {
		render(
			<ConfirmDeleteSessionDialog
				session={null}
				onCancel={() => {}}
				onConfirm={() => {}}
			/>,
		);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("deletes only on an explicit confirm", async () => {
		const onCancel = vi.fn();
		const onConfirm = vi.fn();
		render(
			<ConfirmDeleteSessionDialog
				session={makeSession({ id: "s-1", title: "Fix the flaky test" })}
				onCancel={onCancel}
				onConfirm={onConfirm}
			/>,
		);
		expect(await screen.findByText("Fix the flaky test")).toBeTruthy();
		// Cancel holds focus, so a reflex Enter backs out instead of deleting.
		expect(document.activeElement).toBe(
			screen.getByRole("button", { name: "Cancel" }),
		);

		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onCancel).toHaveBeenCalled();
		expect(onConfirm).not.toHaveBeenCalled();

		await userEvent.click(screen.getByRole("button", { name: "Delete" }));
		expect(onConfirm).toHaveBeenCalledWith("s-1");
	});
});
