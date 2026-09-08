import * as React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { Highlight, themes } from "prism-react-renderer";
import remarkGfm from "remark-gfm";
import { CopyButton } from "@/components/ui/copy-button";
import { cn } from "@/lib/utils";
import { useIsDark } from "@/lib/use-is-dark";

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
function PrismCode({
	language,
	code,
}: {
	language: string;
	code: string;
}) {
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
	a: ({ className, ...props }) => (
		<a
			target="_blank"
			rel="noreferrer"
			className={cn(
				"underline underline-offset-2 hover:no-underline",
				className,
			)}
			{...props}
		/>
	),
	blockquote: ({ className, ...props }) => (
		<blockquote
			className={cn(
				"mb-2 border-l-2 border-zinc-300 pl-3 text-muted-foreground italic last:mb-0 dark:border-zinc-700",
				className,
			)}
			{...props}
		/>
	),
	hr: ({ className, ...props }) => (
		<hr
			className={cn("my-3 border-zinc-200 dark:border-zinc-800", className)}
			{...props}
		/>
	),
	table: ({ className, ...props }) => (
		<div className="mb-2 overflow-x-auto last:mb-0">
			<table className={cn("w-full border-collapse text-xs", className)} {...props} />
		</div>
	),
	th: ({ className, ...props }) => (
		<th
			className={cn(
				"border-b border-zinc-300 px-2 py-1 text-left font-medium dark:border-zinc-700",
				className,
			)}
			{...props}
		/>
	),
	td: ({ className, ...props }) => (
		<td
			className={cn(
				"border-b border-zinc-200 px-2 py-1 dark:border-zinc-800",
				className,
			)}
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
					"overflow-x-auto rounded-md border border-zinc-200 bg-muted/60 p-3 font-mono text-xs leading-relaxed text-foreground dark:border-zinc-800",
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
		if (language)
			return <PrismCode language={language} code={text} />;
		return (
			<code
				className={cn(
					"rounded bg-muted/60 px-1 py-0.5 font-mono text-[0.85em]",
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
