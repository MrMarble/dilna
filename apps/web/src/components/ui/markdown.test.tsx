import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "@/components/ui/markdown";

afterEach(() => {
	document.documentElement.classList.remove("dark");
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
