import type { Artefact, ArtefactKind } from "@dilna/shared";
import type { LucideIcon } from "lucide-react";
import { FileCode, FileImage, FileText, FileType, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { artefactUrl } from "@/api/client";
import { Markdown } from "@/components/ui/markdown";

/**
 * One renderer per {@link ArtefactKind} (ADR-0032 for `"html"`, ADR-0043 for
 * the rest), split out of `ArtefactViewer` so the dialog owns chrome — header,
 * raw toggle, escape hatch — and this module owns "how do these bytes become
 * something the user can read".
 *
 * Every kind is rendered by the **browser**, never by dilna string-building
 * HTML from model output. That is the property the serve route's per-kind CSP
 * depends on (see the artefacts route): markdown goes through `react-markdown`,
 * which escapes rather than injects; PDF and image kinds are handed to the
 * browser's own viewers. Nothing here may ever introduce a path where
 * agent-authored text becomes markup in dilna's origin — including "just
 * `dangerouslySetInnerHTML` the markdown for now".
 */

/** Icon per kind, used by the context panel's list. Lives beside the renderer
 * map so a kind that is renderable but visually indistinguishable in the list
 * is a compile error rather than a subtle UI wart — `Record<ArtefactKind, …>`
 * is total over the union. */
export const ARTEFACT_KIND_ICONS: Record<ArtefactKind, LucideIcon> = {
	html: FileCode,
	markdown: FileText,
	pdf: FileType,
	image: FileImage,
};

/**
 * Fetch an artefact's bytes as text. Only used for the `"markdown"` kind, which
 * is the one kind dilna itself has to interpret rather than hand to the browser.
 *
 * Lives in the **viewer**, not in the markdown renderers, because those two
 * swap on every toggle and a fetch owned by either would re-request the bytes
 * each time — they are immutable, so that round trip can only ever fail or
 * return the same thing. The viewer owns it and passes the text down.
 *
 * The bytes come back over the same hardened route the iframe uses, so the
 * response carries the per-kind `Content-Security-Policy` and `nosniff` — which
 * is why the renderer that receives the text can be chosen by content. The
 * response's `Content-Type` must be `text/*` or the read is refused: if the
 * route ever started returning markup or an image for a markdown artefact, the
 * viewer has to surface that as an error rather than hand the bytes to the
 * markdown renderer and hope it escapes them.
 */
export function useArtefactText(
	sessionId: string,
	artefact: Artefact | null,
): { text: string | null; error: boolean } {
	const [text, setText] = useState<string | null>(null);
	const [error, setError] = useState(false);
	// Tolerates `null` so callers don't have to break the rules of hooks to call
	// it before their own early return. A null artefact means "no dialog open",
	// which is a settled state, not a loading one.
	const url = artefact ? artefactUrl(sessionId, artefact.id) : null;

	useEffect(() => {
		if (!url) return;
		let cancelled = false;
		setText(null);
		setError(false);
		fetch(url)
			.then((res) => {
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				const type = res.headers.get("Content-Type") ?? "";
				// Loose prefix match: the server sends `text/markdown; charset=utf-8`.
				// Anything not `text/*` is refused rather than rendered.
				if (!type.startsWith("text/")) {
					throw new Error(`unexpected Content-Type: ${type}`);
				}
				return res.text();
			})
			.then((body) => {
				if (!cancelled) setText(body);
			})
			.catch(() => {
				if (!cancelled) setError(true);
			});
		return () => {
			cancelled = true;
		};
	}, [url]);

	return { text, error };
}

function Centered({ children }: { children: React.ReactNode }) {
	return (
		<div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
			{children}
		</div>
	);
}

/** Shared loading/error/no-content states for the markdown pair, so the two
 * modes can't disagree about what a failure looks like. */
function AsyncText({
	state,
	render,
}: {
	state: { text: string | null; error: boolean };
	render: (text: string) => React.ReactNode;
}) {
	if (state.error) return <Centered>Could not load this file.</Centered>;
	if (state.text === null) {
		return (
			<Centered>
				<Loader2 className="size-4 animate-spin" />
			</Centered>
		);
	}
	return <>{render(state.text)}</>;
}

/** `"html"`, and the only kind that gets the sandboxed iframe.
 *
 * The content is model-generated HTML, so it renders inside `<iframe sandbox>`
 * with **no tokens granted**: no scripts, no forms, no same-origin access, no
 * top-level navigation. That is one of two independent layers — the server also
 * serves the bytes under a `default-src 'none'` CSP with no `script-src`.
 *
 * Do not add `allow-scripts` to make a report "work properly". A report that
 * needs JavaScript is out of scope by decision, not by oversight: adding it
 * alongside `allow-same-origin` re-opens exactly the hole the sandbox closes.
 * The publish tool's description tells the Agent this in concrete terms, which
 * is the actual fix for "my report used a CDN and came out blank".
 */
function HtmlArtefact({ src, title }: { src: string; title: string }) {
	return (
		<iframe
			src={src}
			title={title}
			sandbox=""
			className="min-h-0 flex-1 rounded-b-lg bg-white"
		/>
	);
}

/** `"markdown"` — rendered, with the raw source a toggle away (see
 * `ArtefactViewer`).
 *
 * Rendered by the same `Markdown` component the chat uses, so an artefact looks
 * like the message that announced it, and so there is exactly one place in the
 * app that decides what model-authored markdown is allowed to become. Note
 * that component configures no `rehype-raw`, so raw HTML in a markdown file is
 * escaped and shown as text rather than executed — which is also why this kind
 * needs no iframe.
 */
function MarkdownArtefact({ text }: { text: string }) {
	return (
		<div className="min-h-0 flex-1 overflow-auto rounded-b-lg bg-background p-4">
			<Markdown>{text}</Markdown>
		</div>
	);
}

/** `"markdown"` in raw mode — the same bytes, unrendered. */
function RawMarkdownArtefact({ text }: { text: string }) {
	return (
		<pre className="min-h-0 flex-1 overflow-auto rounded-b-lg bg-muted/30 p-4 font-mono text-xs whitespace-pre-wrap">
			{text}
		</pre>
	);
}

/** `"pdf"` — the browser's native viewer via `<iframe src>`.
 *
 * Deliberately *not* sandboxed: a `sandbox` attribute on a PDF stops Chrome
 * handing the response to its internal viewer and the frame renders blank. The
 * serve route leaves `sandbox` off for the same reason (see the artefacts
 * route), and the PDF plugin runs in its own process rather than dilna's origin,
 * so this does not reopen the HTML case.
 */
function PdfArtefact({ src, title }: { src: string; title: string }) {
	return (
		<iframe src={src} title={title} className="min-h-0 flex-1 rounded-b-lg" />
	);
}

/** `"image"` — a plain bitmap, centred on a checkerboard-free background.
 *
 * No SVG can reach here: SVG is refused at publish time precisely because it
 * is markup that would render in this `img` context with no sandbox around it.
 */
function ImageArtefact({ src, alt }: { src: string; alt: string }) {
	return (
		<div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-b-lg bg-muted/30 p-6">
			<img
				src={src}
				alt={alt}
				className="max-h-full max-w-full object-contain"
			/>
		</div>
	);
}

/**
 * The body of the artefact dialog, dispatching on kind.
 *
 * Exhaustive by `switch` over the closed {@link ArtefactKind} union, with a
 * `never` check at the end, so adding a kind to `packages/shared` is a compile
 * error here rather than a blank panel at runtime. That matters more than usual
 * for this feature: the whole point of the publish-time allowlist is that dilna
 * never stores a file it can't show, and this function is the other half of
 * that contract.
 */
export function ArtefactBody({
	sessionId,
	artefact,
	raw,
	text,
}: {
	sessionId: string;
	artefact: Artefact;
	/** Only meaningful for `"markdown"`; the viewer decides whether to pass it. */
	raw: boolean;
	/** Markdown bytes, fetched by the viewer via {@link useArtefactText}. Ignored
	 * by every other kind, which the browser fetches itself. */
	text: { text: string | null; error: boolean };
}) {
	const src = artefactUrl(sessionId, artefact.id);

	switch (artefact.kind) {
		case "html":
			return <HtmlArtefact src={src} title={artefact.title} />;
		case "markdown":
			return (
				<AsyncText
					state={text}
					render={(body) =>
						raw ? (
							<RawMarkdownArtefact text={body} />
						) : (
							<MarkdownArtefact text={body} />
						)
					}
				/>
			);
		case "pdf":
			return <PdfArtefact src={src} title={artefact.title} />;
		case "image":
			return <ImageArtefact src={src} alt={artefact.title} />;
		default: {
			// Exhaustiveness guard: a new ArtefactKind that nothing renders would
			// otherwise reach the UI as an empty frame.
			const unreachable: never = artefact.kind;
			return <Centered>Unsupported artefact type: {unreachable}</Centered>;
		}
	}
}
