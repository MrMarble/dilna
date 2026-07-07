import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeToggle } from "@/components/ThemeToggle";

function mockMatchMedia(prefersDark: boolean) {
	vi.stubGlobal(
		"matchMedia",
		vi.fn().mockReturnValue({
			matches: prefersDark,
			media: "(prefers-color-scheme: dark)",
			addEventListener: () => {},
			removeEventListener: () => {},
		}),
	);
}

describe("ThemeToggle", () => {
	beforeEach(() => {
		localStorage.clear();
		document.documentElement.classList.remove("dark");
		mockMatchMedia(false);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("shows a moon and offers to switch to dark mode when in light mode", () => {
		render(<ThemeToggle />);
		expect(
			screen.getByRole("button", { name: "Switch to dark mode" }),
		).toBeInTheDocument();
	});

	it("switches to dark mode on click and updates the document root", async () => {
		const user = userEvent.setup();
		render(<ThemeToggle />);

		await user.click(
			screen.getByRole("button", { name: "Switch to dark mode" }),
		);

		expect(
			screen.getByRole("button", { name: "Switch to light mode" }),
		).toBeInTheDocument();
		expect(document.documentElement.classList.contains("dark")).toBe(true);
		expect(localStorage.getItem("dilna-theme")).toBe("dark");
	});
});
