import { describe, expect, it } from "vitest";
import {
	buildLlmEndpointCandidates,
	createWebFetchTool,
	FETCH_MAX_OUTPUT_CHARS,
	type FetchImpl,
	finalizeOutput,
	htmlToMarkdown,
	isLowQualityOutput,
	loadPage,
	looksLikeHtml,
	normalizeFetchUrl,
	renderUrl,
	repairCollapsedScheme,
} from "./webFetchTool";

/** Build a fetch stub from a url → responder map. Unknown URLs 404. */
function fakeFetch(
	routes: Record<string, () => Response>,
	log?: string[],
): FetchImpl {
	return (async (input: string | URL | Request) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		log?.push(url);
		const responder = routes[url];
		if (!responder) return new Response("not found", { status: 404 });
		return responder();
	}) as FetchImpl;
}

function html(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: { "content-type": "text/html; charset=utf-8" },
	});
}

const ARTICLE_HTML = `<!doctype html><html><head><title>T</title><style>body{}</style><script>evil()</script></head><body>
<h1>Release notes</h1>
<p>This paragraph describes the release in enough detail to comfortably clear the hundred-character minimum threshold that the renderer applies before accepting output as substantial.</p>
<ul><li>First change</li><li>Second change</li></ul>
</body></html>`;

describe("normalizeFetchUrl", () => {
	it("adds https to scheme-less URLs", () => {
		expect(normalizeFetchUrl("example.com/x")).toBe("https://example.com/x");
	});

	it("repairs a collapsed scheme", () => {
		expect(repairCollapsedScheme("https:/example.com/x")).toBe(
			"https://example.com/x",
		);
		expect(normalizeFetchUrl("https:/example.com/x")).toBe(
			"https://example.com/x",
		);
	});

	it("keeps http(s) URLs as-is", () => {
		expect(normalizeFetchUrl("http://example.com")).toBe("http://example.com");
	});

	it("rejects non-http schemes", () => {
		expect(() => normalizeFetchUrl("file:///etc/passwd")).toThrow(
			/unsupported URL scheme/,
		);
		expect(() => normalizeFetchUrl("ftp://example.com")).toThrow(
			/unsupported URL scheme/,
		);
	});
});

describe("looksLikeHtml / isLowQualityOutput / finalizeOutput", () => {
	it("detects html by leading tag", () => {
		expect(looksLikeHtml("  <!DOCTYPE html><html>")).toBe(true);
		expect(looksLikeHtml("# markdown")).toBe(false);
	});

	it("flags JS-gated output", () => {
		expect(isLowQualityOutput("Please enable JavaScript to continue")).toBe(
			true,
		);
	});

	it("flags navigation-heavy output", () => {
		const nav = Array.from({ length: 20 }, (_, i) => `[Link ${i}]`).join("\n");
		expect(isLowQualityOutput(nav)).toBe(true);
	});

	it("collapses blank runs and caps output", () => {
		const { content, truncated } = finalizeOutput("a\n\n\n\n\nb");
		expect(content).toBe("a\n\nb");
		expect(truncated).toBe(false);
		const big = finalizeOutput("x".repeat(FETCH_MAX_OUTPUT_CHARS + 100));
		expect(big.truncated).toBe(true);
		expect(big.content.length).toBe(FETCH_MAX_OUTPUT_CHARS);
	});
});

describe("htmlToMarkdown", () => {
	it("converts structure and strips script/style", () => {
		const md = htmlToMarkdown(ARTICLE_HTML);
		expect(md).toContain("# Release notes");
		expect(md).toMatch(/-\s+First change/);
		expect(md).not.toContain("evil()");
		expect(md).not.toContain("body{}");
		// <title> text must not leak into the rendering
		expect(md.startsWith("T\n")).toBe(false);
	});
});

describe("buildLlmEndpointCandidates", () => {
	it("uses well-known locations for the root", () => {
		expect(buildLlmEndpointCandidates("https://example.com/")).toEqual([
			"https://example.com/.well-known/llms.txt",
			"https://example.com/llms.txt",
			"https://example.com/llms.md",
		]);
	});

	it("scopes deepest-first for nested paths", () => {
		expect(
			buildLlmEndpointCandidates("https://example.com/docs/guide/page"),
		).toEqual([
			"https://example.com/docs/guide/llms.txt",
			"https://example.com/docs/guide/llms.md",
			"https://example.com/docs/llms.txt",
			"https://example.com/docs/llms.md",
		]);
	});
});

describe("loadPage", () => {
	it("retries the user-agent ladder on bot walls", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls++;
			if (calls < 3) {
				return new Response("Access denied - cloudflare challenge", {
					status: 403,
					headers: { "content-type": "text/html" },
				});
			}
			return new Response("real content", {
				status: 200,
				headers: { "content-type": "text/plain" },
			});
		}) as FetchImpl;
		const result = await loadPage("https://example.com/", { fetchImpl });
		expect(result.ok).toBe(true);
		expect(result.content).toBe("real content");
		expect(calls).toBe(3);
	});

	it("retries once on 429 honoring a bounded Retry-After", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls++;
			if (calls === 1) {
				return new Response("slow down", {
					status: 429,
					headers: { "retry-after": "0" },
				});
			}
			return new Response("ok now", {
				status: 200,
				headers: { "content-type": "text/plain" },
			});
		}) as FetchImpl;
		const result = await loadPage("https://example.com/", { fetchImpl });
		expect(result.ok).toBe(true);
		expect(result.content).toBe("ok now");
		expect(calls).toBe(2);
	});

	it("cuts the body at maxBytes and flags truncation", async () => {
		const fetchImpl = (async () =>
			new Response("abcdefghij", {
				status: 200,
				headers: { "content-type": "text/plain" },
			})) as FetchImpl;
		const result = await loadPage("https://example.com/", {
			fetchImpl,
			maxBytes: 4,
		});
		expect(result.ok).toBe(true);
		expect(result.truncated).toBe(true);
	});

	it("decodes a non-UTF-8 charset from the content-type header", async () => {
		const latin1 = Buffer.from("caf\xe9", "latin1");
		const fetchImpl = (async () =>
			new Response(latin1, {
				status: 200,
				headers: { "content-type": "text/plain; charset=iso-8859-1" },
			})) as FetchImpl;
		const result = await loadPage("https://example.com/", { fetchImpl });
		expect(result.content).toBe("café");
	});
});

describe("renderUrl", () => {
	it("pretty-prints JSON", async () => {
		const fetchImpl = fakeFetch({
			"https://api.example.com/data": () =>
				new Response('{"a":1,"b":[2,3]}', {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		});
		const result = await renderUrl("https://api.example.com/data", {
			fetchImpl,
		});
		expect(result.method).toBe("json");
		expect(result.content).toBe(
			'{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}',
		);
	});

	it("passes plain text through", async () => {
		const fetchImpl = fakeFetch({
			"https://example.com/notes.txt": () =>
				new Response("just text", {
					status: 200,
					headers: { "content-type": "text/plain" },
				}),
		});
		const result = await renderUrl("https://example.com/notes.txt", {
			fetchImpl,
		});
		expect(result.method).toBe("text");
		expect(result.content).toBe("just text");
	});

	it("prefers a .md suffix mirror over rendering", async () => {
		const fetchImpl = fakeFetch({
			"https://example.com/docs/page": () => html(ARTICLE_HTML),
			"https://example.com/docs/page.md": () =>
				new Response(
					`# Markdown mirror\n\n${"Real markdown content served from the llms.txt-style per-page mirror endpoint. ".repeat(3)}`,
					{ status: 200, headers: { "content-type": "text/markdown" } },
				),
		});
		const result = await renderUrl("https://example.com/docs/page", {
			fetchImpl,
		});
		expect(result.method).toBe("md-suffix");
		expect(result.content).toContain("# Markdown mirror");
	});

	it("falls back to local html-to-markdown rendering", async () => {
		const fetchImpl = fakeFetch({
			"https://example.com/docs/page": () => html(ARTICLE_HTML),
		});
		const result = await renderUrl("https://example.com/docs/page", {
			fetchImpl,
		});
		expect(result.method).toBe("html-to-markdown");
		expect(result.contentType).toBe("text/markdown");
		expect(result.content).toContain("# Release notes");
		expect(result.content).not.toContain("<h1>");
	});

	it("falls back to llms.txt when rendering is low quality", async () => {
		const gated = `<!doctype html><html><body><p>Please enable JavaScript to view this page.</p></body></html>`;
		const llmsBody = `Docs index for agents. ${"Substantial plain-text content describing the documentation set. ".repeat(3)}`;
		const fetchImpl = fakeFetch({
			"https://example.com/docs/page": () => html(gated),
			"https://example.com/docs/llms.txt": () =>
				new Response(llmsBody, {
					status: 200,
					headers: { "content-type": "text/plain" },
				}),
		});
		const result = await renderUrl("https://example.com/docs/page", {
			fetchImpl,
		});
		expect(result.method).toBe("llms.txt");
		expect(result.content).toContain("Docs index for agents.");
		expect(result.notes.join(";")).toContain("llms.txt");
	});

	it("raw mode returns the body verbatim", async () => {
		const fetchImpl = fakeFetch({
			"https://example.com/docs/page": () => html(ARTICLE_HTML),
		});
		const result = await renderUrl("https://example.com/docs/page", {
			fetchImpl,
			raw: true,
		});
		expect(result.method).toBe("raw");
		expect(result.content).toContain("<h1>Release notes</h1>");
	});

	it("reports binary payloads as a notice instead of bytes", async () => {
		const fetchImpl = fakeFetch({
			"https://example.com/blob.bin": () =>
				new Response(Buffer.from([0x50, 0x4b, 0x00, 0x01, 0x02, 0x00]), {
					status: 200,
					headers: { "content-type": "application/octet-stream" },
				}),
		});
		const result = await renderUrl("https://example.com/blob.bin", {
			fetchImpl,
		});
		expect(result.method).toBe("binary");
		expect(result.content).toContain(
			"[Binary content: application/octet-stream]",
		);
	});

	it("throws on HTTP errors", async () => {
		const fetchImpl = fakeFetch({});
		await expect(
			renderUrl("https://example.com/missing", { fetchImpl }),
		).rejects.toThrow(/HTTP 404/);
	});

	it("throws on transport errors", async () => {
		const fetchImpl = (async () => {
			throw new Error("getaddrinfo ENOTFOUND");
		}) as FetchImpl;
		await expect(
			renderUrl("https://nope.invalid/", { fetchImpl }),
		).rejects.toThrow(/ENOTFOUND/);
	});
});

describe("createWebFetchTool", () => {
	it("exposes the fetch tool shape and renders with a header", async () => {
		const tool = createWebFetchTool({
			fetchImpl: fakeFetch({
				"https://example.com/docs/page": () => html(ARTICLE_HTML),
			}),
		});
		expect(tool.name).toBe("fetch");
		const result = await tool.execute("call-1", {
			url: "example.com/docs/page",
		});
		const text = (result.content[0] as { type: "text"; text: string }).text;
		expect(text).toContain("URL: https://example.com/docs/page");
		expect(text).toContain("Method: html-to-markdown");
		expect(text).toContain("# Release notes");
		expect(result.details).toMatchObject({
			method: "html-to-markdown",
			truncated: false,
		});
	});
});
