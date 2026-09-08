import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyButton } from "@/components/ui/copy-button";

/** Installs a stub `navigator.clipboard.writeText` and hands back the spy. */
function stubClipboard(impl: () => Promise<void> = () => Promise.resolve()) {
	const writeText = vi.fn(impl);
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText },
		configurable: true,
	});
	return writeText;
}

afterEach(() => {
	vi.useRealTimers();
	// @ts-expect-error -- clearing the stub between tests
	delete navigator.clipboard;
});

describe("CopyButton", () => {
	it("writes the text to the clipboard on click", async () => {
		const writeText = stubClipboard();
		render(<CopyButton getText={() => "hello world"} />);

		await userEvent.click(screen.getByRole("button", { name: "Copy" }));

		expect(writeText).toHaveBeenCalledWith("hello world");
	});

	it("calls getText at click time, not at render time", async () => {
		const writeText = stubClipboard();
		let value = "before";
		render(<CopyButton getText={() => value} />);

		value = "after";
		await userEvent.click(screen.getByRole("button", { name: "Copy" }));

		expect(writeText).toHaveBeenCalledWith("after");
	});

	it("announces the copy, then reverts", async () => {
		stubClipboard();
		render(<CopyButton getText={() => "x"} />);

		await userEvent.click(screen.getByRole("button", { name: "Copy" }));
		expect(await screen.findByRole("status")).toHaveTextContent("Copied");

		await waitFor(
			() => expect(screen.getByRole("status")).toHaveTextContent(""),
			{ timeout: 3000 },
		);
	});

	it("falls back to execCommand when the clipboard API rejects", async () => {
		stubClipboard(() => Promise.reject(new Error("not allowed")));
		const exec = vi.fn(() => true);
		// happy-dom has no execCommand; define it for the fallback path.
		Object.defineProperty(document, "execCommand", {
			value: exec,
			configurable: true,
		});

		render(<CopyButton getText={() => "fallback text"} />);
		await userEvent.click(screen.getByRole("button", { name: "Copy" }));

		expect(exec).toHaveBeenCalledWith("copy");
		expect(await screen.findByRole("status")).toHaveTextContent("Copied");
	});

	it("reports failure when no copy mechanism works", async () => {
		stubClipboard(() => Promise.reject(new Error("not allowed")));
		Object.defineProperty(document, "execCommand", {
			value: vi.fn(() => false),
			configurable: true,
		});

		render(<CopyButton getText={() => "nope"} />);
		await userEvent.click(screen.getByRole("button", { name: "Copy" }));

		expect(await screen.findByRole("status")).toHaveTextContent("Copy failed");
	});

	it("uses a custom accessible label", () => {
		stubClipboard();
		render(<CopyButton getText={() => "x"} label="Copy message" />);

		expect(
			screen.getByRole("button", { name: "Copy message" }),
		).toBeInTheDocument();
	});
});
