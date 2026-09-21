import { Highlight, themes } from "prism-react-renderer";
import * as React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyButton } from "@/components/ui/copy-button";
import { useIsDark } from "@/lib/use-is-dark";
import { cn } from "@/lib/utils";

const LIGHT_THEME = themes.oneLight;
const DARK_THEME = themes.oneDark;

/** Extract a Prism language id from the `language-*` class react-markdown emits. */
function languageFrom(source?: string): string | null | undefined {
	if (!source) return null;
	return source.match(/\blanguage-([\w-]+)/)?.[1];
}

/** Pulls the fenced block's source text out of the `<code>` element
 *  react-markdown hands to `pre` as its only child. Reading the child's props
 *  rather than the DOM keeps the copy exact: by the time it's rendered the
 *  body has been split into per-token <span>s, which only reassemble to the
 *  original if you also reconstruct the whitespace between them. */
function codeTextFrom(children: React.ReactNode): string {
	const child = React.Children.toArray(children).find((node) =>
		React.isValidElement(node),
	) as React.ReactElement<{ children?: React.ReactNode }> | undefined;
	const body = child?.props.children;
	if (typeof body === "string") return body.replace(/\n$/, "");
	// Defensive: a non-string body means an inline-formatted fence, which
	// react-markdown doesn't produce today. Fall back to a flat join.
	return React.Children.toArray(body)
		.filter((node) => typeof node === "string")
		.join("")
		.replace(/\n$/, "");
}

/** Bodies of a fenced block rendered as prism-colored tokens, wrapped in a
 *  semantic <code> whose container <pre> (below) owns the block chrome. */
function PrismCode({ language, code }: { language: string; code: string }) {
	const dark = useIsDark();
	const theme = dark ? DARK_THEME : LIGHT_THEME;

	return (
		<code lang={language}>
			<Highlight code={code} language={language} theme={theme}>
				{({ tokens, getTokenProps }) =>
					tokens.map((line, lineIdx) => (
						// Token lines carry no stable identity and grow during streaming,
						// so index keys are the only choice.
						<React.Fragment key={lineIdx}>
							{line.map((token, tokenIdx) => (
								<span key={tokenIdx} {...getTokenProps({ token })} />
							))}
							{"\n"}
						</React.Fragment>
					))
				}
			</Highlight>
		</code>
	);
}

const components: Components = {
	// Headings are the one element Tailwind's preflight actively breaks: it resets
	// h1-h6 to `font-size: 1em; font-weight: inherit; margin: 0`, so without these
	// rules a `##` in an agent reply renders *identically to a paragraph*. That is
	// the worst possible default for this app, whose entire content surface is
	// agent-written markdown.
	//
	// The scale is deliberately restrained rather than dramatic: an agent reply is
	// prose first, and a heading has to organise a conversation without shouting
	// inside it. h1/h2 are the same size because markdown in a chat reply rarely
	// uses both, and their distinction is carried by weight and the rule under h1.
	h1: ({ className, ...props }) => (
		<h1
			className={cn(
				"mt-5 mb-2 border-b border-border pb-1.5 text-lg font-semibold tracking-tight first:mt-0",
				className,
			)}
			{...props}
		/>
	),
	h2: ({ className, ...props }) => (
		<h2
			className={cn(
				"mt-5 mb-2 text-base font-semibold tracking-tight first:mt-0",
				className,
			)}
			{...props}
		/>
	),
	h3: ({ className, ...props }) => (
		<h3
			className={cn(
				"mt-4 mb-1.5 text-[0.9375rem] font-semibold first:mt-0",
				className,
			)}
			{...props}
		/>
	),
	h4: ({ className, ...props }) => (
		<h4
			className={cn(
				"mt-3.5 mb-1.5 text-sm font-semibold first:mt-0",
				className,
			)}
			{...props}
		/>
	),
	// h5/h6 stay at body size but gain weight and a muted tone: past the fourth
	// level a heading is a label, not a structural break.
	h5: ({ className, ...props }) => (
		<h5
			className={cn(
				"mt-3 mb-1 text-sm font-semibold text-muted-foreground first:mt-0",
				className,
			)}
			{...props}
		/>
	),
	h6: ({ className, ...props }) => (
		<h6
			className={cn(
				"mt-3 mb-1 text-xs font-semibold text-muted-foreground first:mt-0",
				className,
			)}
			{...props}
		/>
	),
	p: ({ className, ...props }) => (
		<p className={cn("mb-2 last:mb-0", className)} {...props} />
	),
	ul: ({ className, ...props }) => (
		<ul
			className={cn("mb-2 list-disc space-y-1 pl-5 last:mb-0", className)}
			{...props}
		/>
	),
	ol: ({ className, ...props }) => (
		<ol
			className={cn("mb-2 list-decimal space-y-1 pl-5 last:mb-0", className)}
			{...props}
		/>
	),
	li: ({ className, ...props }) => (
		<li className={cn("marker:text-muted-foreground", className)} {...props} />
	),
	// Links carry the highlight hue: in a long agent reply a link is the one
	// thing the reader may want to act on, and an underline alone drowns in prose.
	// The hue is already budgeted for "something waiting on you".
	a: ({ className, ...props }) => (
		<a
			target="_blank"
			rel="noreferrer"
			className={cn(
				"font-medium text-highlight underline decoration-highlight-quiet underline-offset-2 hover:decoration-highlight",
				className,
			)}
			{...props}
		/>
	),
	strong: ({ className, ...props }) => (
		<strong
			className={cn("font-semibold text-foreground", className)}
			{...props}
		/>
	),
	blockquote: ({ className, ...props }) => (
		<blockquote
			className={cn(
				"mb-2 border-l-2 border-border pl-3 text-muted-foreground italic last:mb-0",
				className,
			)}
			{...props}
		/>
	),
	hr: ({ className, ...props }) => (
		<hr className={cn("my-3 border-border", className)} {...props} />
	),
	table: ({ className, ...props }) => (
		<div className="mb-2 overflow-x-auto last:mb-0">
			<table
				className={cn("w-full border-collapse text-xs", className)}
				{...props}
			/>
		</div>
	),
	th: ({ className, ...props }) => (
		<th
			className={cn(
				"border-b border-border px-2 py-1.5 text-left font-medium text-muted-foreground",
				className,
			)}
			{...props}
		/>
	),
	td: ({ className, ...props }) => (
		<td
			className={cn("border-b border-border px-2 py-1.5", className)}
			{...props}
		/>
	),
	// A fenced block is the <pre>-wrapped <code> you see here; keep <pre> as
	// the chrome/scroller and let the `code` below provide its own element.
	// The wrapper exists purely to anchor the copy button outside the
	// scrolling <pre>, so it stays put when the block scrolls sideways.
	pre: ({ className, children, ...props }) => (
		<div className="group/code relative mb-2 last:mb-0">
			<pre
				className={cn(
					"overflow-x-auto rounded-md border border-border bg-muted/60 p-3 font-mono text-xs leading-relaxed text-foreground",
					className,
				)}
				{...props}
			>
				{children}
			</pre>
			<CopyButton
				getText={() => codeTextFrom(children)}
				label="Copy code"
				className="absolute top-1.5 right-1.5 bg-muted/80 opacity-0 backdrop-blur-sm transition-opacity focus-visible:opacity-100 group-hover/code:opacity-100"
			/>
		</div>
	),
	// Fenced (lang tagged) blocks get Prism token coloring; bare inline code
	// keeps the familiar pill. Distinguish by the language-* class.
	code: ({ className, children, ...props }) => {
		const language = languageFrom(className);
		// react-markdown keeps one trailing newline on a fenced body; strip it
		// so Prism sees exactly the block's own text.
		const text =
			typeof children === "string" ? children.replace(/\n$/, "") : "";
		if (language) return <PrismCode language={language} code={text} />;
		return (
			<code
				className={cn(
					"rounded-sm border border-border/60 bg-muted px-1 py-0.5 font-mono text-[0.85em]",
					className,
				)}
				{...props}
			>
				{children}
			</code>
		);
	},
};

export function Markdown({ children }: { children: string }) {
	return (
		<div className="text-sm leading-relaxed [&>:first-child]:mt-0 [&>:last-child]:mb-0">
			<ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
				{children}
			</ReactMarkdown>
		</div>
	);
}
