import { setTimeout as sleep } from "node:timers/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai/compat";
import TurndownService from "turndown";

/**
 * Web-fetch tool for pi sessions (issue #138 §11 / §4's "read handles URLs").
 *
 * A scoped-down port of oh-my-pi's `fetch` pipeline
 * (`packages/coding-agent/src/tools/fetch.ts` + `src/web/scrapers/types.ts`
 * at can1357/oh-my-pi) — omp is a sibling fork of the pi lineage, not
 * upstream of the `@earendil-works/pi-*` packages dilna pins, so this is a
 * reimplementation, not a dependency bump (see the issue's relationship
 * caveat). What's kept vs. consciously dropped for v1 (ADR-0026):
 *
 * Kept (the parts that measurably improve what the model reads):
 * - URL normalization: scheme-less URLs get `https://`, and a scheme whose
 *   `//` was collapsed to `/` by path normalization is repaired.
 * - Robust page loading: bounded streaming (byte cap, not just a timeout),
 *   charset-aware decode, redirect following, a small user-agent ladder
 *   retried on bot-block heuristics, and a single bounded Retry-After
 *   honoring retry on 429.
 * - Markdown-first strategies for HTML, in omp's order: `.md` suffix
 *   (llms.txt convention), content negotiation (`Accept: text/markdown`),
 *   then local HTML→markdown rendering (turndown — the same engine omp's own
 *   `htmlToBasicMarkdown` fallback uses), with `llms.txt` endpoints as the
 *   fallback when rendering fails or looks JS-gated/navigation-heavy.
 * - Content-type dispatch: JSON pretty-printed, plain text/markdown passed
 *   through, binary payloads reported as a one-line notice instead of
 *   garbage bytes.
 * - Output hygiene: blank-run collapsing and a hard output cap in line with
 *   the read tool's own truncation budget.
 *
 * Dropped (tracked in #138 for possible later waves): the ~80 site-specific
 * scrapers, web *search* providers, remote reader backends
 * (Jina/Firecrawl/Parallel/trafilatura/lynx), RSS/Atom feed rendering,
 * `<link rel=alternate>` discovery, and binary rendering (PDF/archives/
 * SQLite/notebooks/inline images).
 *
 * Runs in the server process, not sandboxed bash — this grants no new
 * capability: dilna's sandbox network policy already allows arbitrary
 * outbound domains for bash (`ensureSandboxInitialized`'s
 * `allowedDomains: ["*"]`), so `curl` could already reach anything this
 * tool can; the tool exists to return *rendered, token-economical* content
 * instead of raw HTML through bash.
 */

export type FetchImpl = typeof fetch;

/** Hard cap on rendered tool output — matches the neighborhood of the read
 * tool's own 50KB truncation budget rather than omp's 500K-chars-into-an-
 * artifact scheme (dilna has no artifact store to spill the remainder to). */
export const FETCH_MAX_OUTPUT_CHARS = 50_000;

/** Streaming byte cap per request. omp allows 50MB because it renders
 * binaries (PDF/archives) from the bytes; v1 renders text only, so 5MB is
 * plenty and bounds worst-case memory. */
export const FETCH_MAX_BYTES = 5 * 1024 * 1024;

/** Overall per-call budget (seconds) — omp's own fetch default. */
const DEFAULT_TIMEOUT_SECONDS = 30;

/** Budget for each opportunistic side-request (`.md` suffix, content
 * negotiation, llms.txt probes) so a slow miss can't eat the whole call. */
const STRATEGY_TIMEOUT_SECONDS = 5;

const RETRY_AFTER_MAX_MS = 10_000;

/** omp's user-agent ladder: plain curl first (many docs sites serve
 * text/plain to curl), then a generic bot, then a real browser UA for
 * bot-walled hosts. */
const USER_AGENTS = [
	"curl/8.0",
	"Mozilla/5.0 (compatible; TextBot/1.0)",
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
];

// ---- URL normalization -----------------------------------------------------

/**
 * Repair a URL whose scheme `//` collapsed to a single `/` (path
 * normalization does this to URLs routed through it). No filesystem path
 * begins with `http:/` or `https:/`, so the repair is unambiguous.
 */
export function repairCollapsedScheme(value: string): string {
	const m = value.match(/^(https?):\/(?!\/)/i);
	return m ? `${m[1]}://${value.slice(m[0].length)}` : value;
}

/** Normalize a URL: repair a collapsed scheme, default to https. Throws on
 * an explicit non-http(s) scheme rather than fetching it. */
export function normalizeFetchUrl(url: string): string {
	const repaired = repairCollapsedScheme(url.trim());
	if (/^https?:\/\//i.test(repaired)) return repaired;
	const scheme = repaired.match(/^([a-z][a-z0-9+.-]*):/i);
	if (scheme) {
		throw new Error(
			`unsupported URL scheme "${scheme[1]}:" — only http(s) URLs can be fetched`,
		);
	}
	return `https://${repaired}`;
}

// ---- Page loading ----------------------------------------------------------

export type LoadPageOptions = {
	timeoutSeconds?: number;
	headers?: Record<string, string>;
	maxBytes?: number;
	signal?: AbortSignal;
	fetchImpl?: FetchImpl;
};

export type LoadPageResult = {
	content: string;
	contentType: string;
	finalUrl: string;
	ok: boolean;
	status?: number;
	/** True when the body was cut mid-stream at maxBytes. */
	truncated?: boolean;
	/** Last transport-level error message when ok is false. */
	error?: string;
};

function combinedSignal(
	signal: AbortSignal | undefined,
	timeoutMs: number,
): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Parse a Retry-After header (seconds or HTTP-date) into a bounded delay. */
function parseRetryAfterMs(value: string | null): number {
	if (!value) return 1_000;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) {
		return Math.min(Math.max(seconds, 0) * 1000, RETRY_AFTER_MAX_MS);
	}
	const date = Date.parse(value);
	if (!Number.isNaN(date)) {
		return Math.min(Math.max(date - Date.now(), 0), RETRY_AFTER_MAX_MS);
	}
	return 1_000;
}

/** Whether a 403/503 body reads like a bot wall — worth retrying with the
 * next user agent on the ladder. */
function isBotBlocked(status: number | undefined, content: string): boolean {
	if (status !== 403 && status !== 503) return false;
	const lower = content.toLowerCase();
	return (
		lower.includes("cloudflare") ||
		lower.includes("captcha") ||
		lower.includes("challenge") ||
		lower.includes("blocked") ||
		lower.includes("access denied") ||
		lower.includes("bot detection")
	);
}

function charsetFromContentType(header: string): string | undefined {
	return /charset\s*=\s*"?([\w-]+)"?/i.exec(header)?.[1];
}

/**
 * Decode a response body honoring the declared charset (Content-Type header,
 * then a cheap `<meta charset>` sniff of the prefix), falling back to UTF-8.
 */
function decodeBody(bytes: Buffer, contentTypeHeader: string): string {
	let label = charsetFromContentType(contentTypeHeader);
	if (!label) {
		// Decodable charsets are ASCII-compatible in the prefix, so a latin1
		// view of the first 2KB is enough to find a <meta charset>.
		label = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(
			bytes.subarray(0, 2048).toString("latin1"),
		)?.[1];
	}
	if (label && !/^utf-?8$/i.test(label)) {
		try {
			return new TextDecoder(label).decode(bytes);
		} catch {
			// Unknown/unsupported label — fall back to UTF-8.
		}
	}
	return bytes.toString("utf-8");
}

/** Fetch a page with timeout, size cap, UA ladder, and one 429 retry. */
export async function loadPage(
	url: string,
	options: LoadPageOptions = {},
): Promise<LoadPageResult> {
	const {
		timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
		headers = {},
		maxBytes = FETCH_MAX_BYTES,
		signal,
		fetchImpl = fetch,
	} = options;

	let lastError: string | undefined;
	let retried429 = false;
	for (let attempt = 0; attempt < USER_AGENTS.length; attempt++) {
		signal?.throwIfAborted();
		const requestSignal = combinedSignal(signal, timeoutSeconds * 1000);
		try {
			const response = await fetchImpl(url, {
				signal: requestSignal,
				headers: {
					"User-Agent": USER_AGENTS[attempt] as string,
					Accept:
						"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.5",
					// omp's note: Cloudflare's Markdown-for-Agents returns corrupted
					// bytes when compression is negotiated.
					"Accept-Encoding": "identity",
					...headers,
				},
				redirect: "follow",
			});

			const rawContentType = response.headers.get("content-type") ?? "";
			const contentType =
				rawContentType.split(";")[0]?.trim().toLowerCase() ?? "";
			// A synthesized Response (tests) has an empty `url`.
			const finalUrl = response.url || url;

			if (response.status === 429 && !retried429) {
				retried429 = true;
				const delayMs = parseRetryAfterMs(response.headers.get("retry-after"));
				void response.body?.cancel().catch(() => {});
				await sleep(delayMs, undefined, { signal });
				attempt--; // Reuse the same user agent for the retry.
				continue;
			}

			const reader = response.body?.getReader();
			if (!reader) {
				return {
					content: "",
					contentType,
					finalUrl,
					ok: response.ok,
					status: response.status,
				};
			}

			const chunks: Uint8Array[] = [];
			let totalSize = 0;
			let truncated = false;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(value);
				totalSize += value.length;
				if (totalSize > maxBytes) {
					truncated = true;
					void reader.cancel().catch(() => {});
					break;
				}
			}

			const content = decodeBody(Buffer.concat(chunks), rawContentType);
			if (
				isBotBlocked(response.status, content) &&
				attempt < USER_AGENTS.length - 1
			) {
				continue;
			}
			return {
				content,
				contentType,
				finalUrl,
				ok: response.ok,
				status: response.status,
				truncated,
			};
		} catch (error) {
			signal?.throwIfAborted();
			lastError = error instanceof Error ? error.message : String(error);
			if (attempt === USER_AGENTS.length - 1) break;
		}
	}
	return {
		content: "",
		contentType: "",
		finalUrl: url,
		ok: false,
		error: lastError,
	};
}

// ---- Rendering helpers -----------------------------------------------------

/** Check if content looks like HTML by inspecting the leading tag. */
export function looksLikeHtml(content: string): boolean {
	const trimmed = content.trim().toLowerCase();
	return (
		trimmed.startsWith("<!doctype") ||
		trimmed.startsWith("<html") ||
		trimmed.startsWith("<head") ||
		trimmed.startsWith("<body")
	);
}

/** Whether rendered output looks JS-gated or mostly navigation (omp's
 * quality gate before accepting a reader backend's output). */
export function isLowQualityOutput(content: string): boolean {
	const lower = content.toLowerCase();
	const jsGated = [
		"enable javascript",
		"javascript required",
		"turn on javascript",
		"please enable javascript",
		"browser not supported",
	];
	if (content.length < 1024 && jsGated.some((t) => lower.includes(t))) {
		return true;
	}
	const lines = content.split("\n").filter((l) => l.trim());
	const shortLines = lines.filter((l) => l.trim().length < 40);
	if (lines.length > 10 && shortLines.length / lines.length > 0.7) {
		return true;
	}
	return false;
}

const BINARY_SAMPLE_CHARS = 4096;

/** NUL bytes or a meaningful density of replacement chars in the decoded
 * prefix ⇒ the payload is binary, not text. */
function sampleLooksBinary(text: string): boolean {
	const limit = Math.min(text.length, BINARY_SAMPLE_CHARS);
	if (limit === 0) return false;
	let replacementCount = 0;
	for (let index = 0; index < limit; index++) {
		const code = text.charCodeAt(index);
		if (code === 0) return true;
		if (code === 0xfffd) replacementCount++;
	}
	return replacementCount >= 3 && replacementCount / limit > 0.01;
}

/** Collapse blank runs and enforce the output cap. */
export function finalizeOutput(content: string): {
	content: string;
	truncated: boolean;
} {
	const cleaned = content.replace(/\n{3,}/g, "\n\n").trim();
	const truncated = cleaned.length > FETCH_MAX_OUTPUT_CHARS;
	return { content: cleaned.slice(0, FETCH_MAX_OUTPUT_CHARS), truncated };
}

function formatJson(content: string): string {
	try {
		return JSON.stringify(JSON.parse(content), null, 2);
	} catch {
		return content;
	}
}

/** Module-level turndown instance, built lazily on first HTML render. */
let turndown: TurndownService | null = null;

function getTurndown(): TurndownService {
	if (!turndown) {
		turndown = new TurndownService({
			headingStyle: "atx",
			codeBlockStyle: "fenced",
			bulletListMarker: "-",
		});
		turndown.remove(["script", "style", "title"]);
	}
	return turndown;
}

/** Convert HTML to markdown, stripping script/style/head noise first. */
export function htmlToMarkdown(html: string): string {
	const cleaned = html
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
	return getTurndown().turndown(cleaned).trim();
}

// ---- Markdown-first strategies for HTML pages ------------------------------

type StrategyContext = {
	signal?: AbortSignal;
	fetchImpl?: FetchImpl;
};

/** Try the URL with `.md` appended (llms.txt convention for per-page
 * markdown mirrors — `/foo/bar` → `/foo/bar.md`, `/foo/` → `/foo/index.html.md`). */
async function tryMdSuffix(
	url: string,
	ctx: StrategyContext,
): Promise<string | null> {
	let candidate: string;
	try {
		const parsed = new URL(url);
		if (parsed.pathname.endsWith("/")) {
			candidate = `${parsed.origin}${parsed.pathname}index.html.md`;
		} else {
			candidate = `${parsed.origin}${parsed.pathname}.md`;
		}
	} catch {
		return null;
	}
	const result = await loadPage(candidate, {
		...ctx,
		timeoutSeconds: STRATEGY_TIMEOUT_SECONDS,
	});
	if (
		result.ok &&
		result.content.trim().length > 100 &&
		!looksLikeHtml(result.content)
	) {
		return result.content;
	}
	return null;
}

/** Re-request the page asking for markdown/plain via content negotiation
 * (Cloudflare's Markdown-for-Agents and various docs hosts honor this). */
async function tryContentNegotiation(
	url: string,
	ctx: StrategyContext,
): Promise<{ content: string; type: string } | null> {
	const result = await loadPage(url, {
		...ctx,
		timeoutSeconds: STRATEGY_TIMEOUT_SECONDS,
		headers: { Accept: "text/markdown, text/plain;q=0.9, text/html;q=0.8" },
	});
	if (!result.ok) return null;
	const mime = result.contentType;
	if (
		(mime.includes("markdown") || mime === "text/plain") &&
		!looksLikeHtml(result.content)
	) {
		return { content: result.content, type: result.contentType };
	}
	return null;
}

/** Build llms.txt candidates scoped to the requested URL, deepest scope
 * first, ending at the origin's well-known locations. */
export function buildLlmEndpointCandidates(url: string): string[] {
	try {
		const parsed = new URL(url);
		if (parsed.pathname === "/") {
			return [
				`${parsed.origin}/.well-known/llms.txt`,
				`${parsed.origin}/llms.txt`,
				`${parsed.origin}/llms.md`,
			];
		}
		const trimmedPath = parsed.pathname.replace(/\/+$/, "");
		const segments = trimmedPath.split("/").filter(Boolean);
		const scopeDepth = parsed.pathname.endsWith("/")
			? segments.length
			: Math.max(segments.length - 1, 1);
		const endpoints: string[] = [];
		for (let depth = scopeDepth; depth >= 1; depth--) {
			const scope = `/${segments.slice(0, depth).join("/")}/`;
			endpoints.push(
				`${parsed.origin}${scope}llms.txt`,
				`${parsed.origin}${scope}llms.md`,
			);
		}
		return endpoints;
	} catch {
		return [];
	}
}

async function tryLlmEndpoints(
	url: string,
	ctx: StrategyContext,
): Promise<{ content: string; endpoint: string } | null> {
	for (const endpoint of buildLlmEndpointCandidates(url)) {
		ctx.signal?.throwIfAborted();
		const result = await loadPage(endpoint, {
			...ctx,
			timeoutSeconds: STRATEGY_TIMEOUT_SECONDS,
		});
		if (
			result.ok &&
			result.content.trim().length > 100 &&
			!looksLikeHtml(result.content)
		) {
			return { content: result.content, endpoint };
		}
	}
	return null;
}

// ---- Main render pipeline --------------------------------------------------

export type FetchRenderResult = {
	url: string;
	finalUrl: string;
	contentType: string;
	/** Which strategy produced the content — surfaced to the model so it can
	 * retry with `raw: true` when a rendering looks off. */
	method: string;
	content: string;
	truncated: boolean;
	notes: string[];
};

export type RenderUrlOptions = {
	raw?: boolean;
	signal?: AbortSignal;
	fetchImpl?: FetchImpl;
};

/** Fetch a URL and render it for model consumption (see module doc comment
 * for the pipeline and what it deliberately omits vs. omp's). */
export async function renderUrl(
	inputUrl: string,
	options: RenderUrlOptions = {},
): Promise<FetchRenderResult> {
	const { raw = false, signal, fetchImpl } = options;
	const ctx: StrategyContext = { signal, fetchImpl };
	const notes: string[] = [];

	const url = normalizeFetchUrl(inputUrl);
	const response = await loadPage(url, { signal, fetchImpl });
	if (!response.ok) {
		const reason = response.status
			? `HTTP ${response.status}`
			: (response.error ?? "transport error");
		throw new Error(`failed to fetch ${url}: ${reason}`);
	}

	const { finalUrl, content: rawContent } = response;
	if (response.truncated) {
		notes.push(
			`Response body exceeded ${FETCH_MAX_BYTES} bytes and was cut mid-stream; content is incomplete`,
		);
	}
	const mime = response.contentType;

	const base = { url, finalUrl, notes };
	const done = (
		method: string,
		content: string,
		contentType: string = mime,
	): FetchRenderResult => {
		const output = finalizeOutput(content);
		if (output.truncated) {
			notes.push(`Output truncated to ${FETCH_MAX_OUTPUT_CHARS} characters`);
		}
		return {
			...base,
			contentType,
			method,
			content: output.content,
			truncated: response.truncated === true || output.truncated,
		};
	};

	// Binary payloads: report a notice instead of garbage bytes (v1 has no
	// PDF/archive/SQLite rendering — see module doc comment).
	if (mime.startsWith("image/") || sampleLooksBinary(rawContent)) {
		const type = mime || "application/octet-stream";
		return done(
			"binary",
			`[Binary content: ${type}] ${finalUrl}\nThis payload is not renderable as text. Use bash (curl) to download it if the bytes themselves are needed.`,
			type,
		);
	}

	const isHtml =
		mime.includes("html") ||
		mime.includes("xhtml") ||
		looksLikeHtml(rawContent);

	// Raw mode: body verbatim, no text shaping.
	if (raw) return done("raw", rawContent);

	if (mime.includes("json")) return done("json", formatJson(rawContent));

	if (
		(mime.includes("text/plain") || mime.includes("markdown")) &&
		!looksLikeHtml(rawContent)
	) {
		return done("text", rawContent);
	}

	if (isHtml) {
		// Digestible formats first — a page-scoped markdown mirror or a
		// markdown content-negotiation response beats any local rendering.
		const mdSuffix = await tryMdSuffix(finalUrl, ctx);
		if (mdSuffix) {
			notes.push("Found .md suffix version");
			return done("md-suffix", mdSuffix, "text/markdown");
		}

		const negotiated = await tryContentNegotiation(url, ctx);
		if (negotiated) {
			notes.push(`Content negotiation returned ${negotiated.type}`);
			return done("content-negotiation", negotiated.content, negotiated.type);
		}

		signal?.throwIfAborted();
		let rendered = "";
		try {
			rendered = htmlToMarkdown(rawContent);
		} catch (error) {
			notes.push(
				`HTML rendering failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}

		if (rendered.trim().length > 100 && !isLowQualityOutput(rendered)) {
			return done("html-to-markdown", rendered, "text/markdown");
		}

		// Rendering failed or looks JS-gated/navigation-heavy — try llms.txt
		// before settling.
		const llm = await tryLlmEndpoints(finalUrl, ctx);
		if (llm) {
			notes.push(`Used llms.txt fallback: ${llm.endpoint}`);
			return done("llms.txt", llm.content, "text/plain");
		}

		if (rendered.trim().length > 0) {
			notes.push("Page appears to require JavaScript or is mostly navigation");
			return done("html-to-markdown", rendered, "text/markdown");
		}
		notes.push("HTML rendering produced no usable output; returning raw HTML");
		return done("raw-html", rawContent);
	}

	// Everything else (XML, CSVs, source files, …): body verbatim.
	return done("text", rawContent);
}

// ---- Tool definition -------------------------------------------------------

const FETCH_TOOL_DESCRIPTION = `Fetch a URL over http(s) and return its content rendered for reading. HTML pages come back as markdown (trying the page's .md mirror, markdown content negotiation, and llms.txt before falling back to local HTML-to-markdown conversion); JSON is pretty-printed; plain text/markdown passes through; binary payloads return a one-line notice instead of bytes. Output is capped at ${FETCH_MAX_OUTPUT_CHARS} characters — a "Method:" header line says which rendering strategy produced the content. Set raw=true to skip all rendering and get the response body verbatim (e.g. when the markdown rendering of a page looks wrong or you need exact file contents). Scheme-less URLs default to https. Use this instead of curl-through-bash when you want page *content*; use bash curl when you need exact bytes, custom headers/methods, or to download a file into the worktree.`;

const fetchToolSchema = Type.Object({
	url: Type.String({
		description: "The http(s) URL to fetch. Scheme-less URLs default to https.",
	}),
	raw: Type.Optional(
		Type.Boolean({
			description:
				"Return the response body verbatim, skipping markdown rendering and JSON pretty-printing (binary detection still applies).",
		}),
	),
});

export type WebFetchToolOptions = {
	/** Injectable fetch implementation — tests only. */
	fetchImpl?: FetchImpl;
};

export function createWebFetchTool(
	options: WebFetchToolOptions = {},
): AgentTool<typeof fetchToolSchema> {
	return {
		name: "fetch",
		label: "Fetch URL",
		description: FETCH_TOOL_DESCRIPTION,
		parameters: fetchToolSchema,
		execute: async (_toolCallId, params, signal) => {
			const result = await renderUrl(params.url, {
				raw: params.raw ?? false,
				signal,
				fetchImpl: options.fetchImpl,
			});
			let header = `URL: ${result.finalUrl}\nContent-Type: ${result.contentType}\nMethod: ${result.method}\n`;
			if (result.notes.length > 0) {
				header += `Notes: ${result.notes.join("; ")}\n`;
			}
			return {
				content: [
					{
						type: "text" as const,
						text: `${header}\n---\n\n${result.content}`,
					},
				],
				details: {
					url: result.url,
					finalUrl: result.finalUrl,
					contentType: result.contentType,
					method: result.method,
					truncated: result.truncated,
				},
			};
		},
	};
}
