import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

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
	pre: ({ className, ...props }) => (
		<pre
			className={cn(
				"mb-2 overflow-x-auto rounded-md bg-muted/40 p-2 font-mono text-xs last:mb-0",
				className,
			)}
			{...props}
		/>
	),
	code: ({ className, ...props }) => {
		// Fenced blocks land inside <pre>, which already provides the block
		// container/background — style only the inline (bare, non-fenced) case.
		const isFenced = className?.includes("language-");
		return (
			<code
				className={cn(
					!isFenced &&
						"rounded bg-muted/60 px-1 py-0.5 font-mono text-[0.85em]",
					className,
				)}
				{...props}
			/>
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
