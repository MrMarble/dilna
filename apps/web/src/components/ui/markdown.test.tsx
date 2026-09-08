import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "@/components/ui/markdown";

afterEach(() => {
	document.documentElement.classList.remove("dark");
	// @ts-expect-error -- clearing the per-test clipboard stub
	delete navigator.clipboard;
});

describe("Markdown code blocks", () => {
	it("keeps inline code uncolored text", () => {
		render(<Markdown>Use `pnpm test` in a terminal.</Markdown>);
		const inline = screen.getByText("pnpm test");
		expect(inline.tagName).toBe("CODE");
		expect(inline.querySelector("span")).toBeNull();
	});

	it("tokenizes a js fence into highlighted spans", async () => {
		render(<Markdown>{"```js\nconst answer = 42;\n```"}</Markdown>);
		const keyword = await screen.findByText("const", {
			selector: "span.token.keyword",
		});
		// Theme color applied as an inline style on the token.
		expect(keyword.style.color).toBeTruthy();
		expect(
			screen.getByText("answer", { selector: "span.token.plain" }),
		).toBeInTheDocument();
	});

	it("styling differs between light and dark", async () => {
		const light = render(<Markdown>{"```js\nconst answer;\n```"}</Markdown>);
		const lightKeyword = await screen.findByText("const", {
			selector: "span.token.keyword",
		});
		light.unmount();
		document.documentElement.classList.add("dark");
		render(<Markdown>{"```js\nconst answer;\n```"}</Markdown>);
		const darkKeyword = await screen.findByText("const", {
			selector: "span.token.keyword",
		});

		expect(darkKeyword.style.color).not.toBe(lightKeyword.style.color);
	});
});

describe("Markdown code block copying", () => {
	function stubClipboard() {
		const writeText = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText },
			configurable: true,
		});
		return writeText;
	}

	it("copies the fence body, not the tokenized DOM text", async () => {
		const writeText = stubClipboard();
		const code = "function add(a, b) {\n\treturn a + b;\n}";
		render(<Markdown>{`\`\`\`js\n${code}\n\`\`\``}</Markdown>);

		await userEvent.click(screen.getByRole("button", { name: "Copy code" }));

		// Indentation and newlines survive verbatim — the whole point, since the
		// rendered block is a pile of per-token spans.
		expect(writeText).toHaveBeenCalledWith(code);
	});

	it("copies an untagged fence too", async () => {
		const writeText = stubClipboard();
		render(<Markdown>{"```\nplain text\n```"}</Markdown>);

		await userEvent.click(screen.getByRole("button", { name: "Copy code" }));

		expect(writeText).toHaveBeenCalledWith("plain text");
	});

	it("gives inline code no copy button", () => {
		render(<Markdown>Use `pnpm test` here.</Markdown>);
		expect(screen.queryByRole("button", { name: "Copy code" })).toBeNull();
	});
});
