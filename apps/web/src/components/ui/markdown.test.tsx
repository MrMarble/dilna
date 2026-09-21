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

describe("Markdown headings", () => {
	// Regression guard for the defect this scale exists to fix: Tailwind's
	// preflight resets h1-h6 to `font-size: 1em; font-weight: inherit; margin: 0`,
	// so a heading with no rule of its own renders exactly like a paragraph.
	// These assert a heading is *distinguishable*, which is the behaviour that
	// regressed — not any particular size.
	it.each([
		["#", 1],
		["##", 2],
		["###", 3],
		["####", 4],
	] as const)("gives `%s` a size distinct from body text", (hashes, level) => {
		render(<Markdown>{`${hashes} Heading\n\nA paragraph.`}</Markdown>);
		const heading = screen.getByRole("heading", { level });
		const paragraph = screen.getByText("A paragraph.");
		// No class assertion: the guard is that *something* separates them.
		expect(heading.className).toContain("font-semibold");
		expect(heading.className).not.toBe(paragraph.className);
	});

	it("weights every level, so none inherits the paragraph's font-weight", () => {
		render(
			<Markdown>
				{
					"# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six"
				}
			</Markdown>,
		);
		for (const level of [1, 2, 3, 4, 5, 6] as const) {
			expect(screen.getByRole("heading", { level }).className).toContain(
				"font-semibold",
			);
		}
	});

	it("collapses the first heading's top margin so a reply doesn't start indented", () => {
		render(<Markdown>{"# Heading\n\nBody."}</Markdown>);
		expect(screen.getByRole("heading", { level: 1 }).className).toContain(
			"first:mt-0",
		);
	});
});

describe("Markdown links", () => {
	it("carries the highlight hue rather than relying on the underline alone", () => {
		render(<Markdown>{"[docs](https://example.com)"}</Markdown>);
		expect(screen.getByRole("link").className).toContain("text-highlight");
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
