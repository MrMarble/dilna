import { Sparkles } from "lucide-react";
import { useEffect, useRef } from "react";
import type { SlashCommand } from "@/lib/slash-commands";
import { cn } from "@/lib/utils";

type Props = {
	commands: readonly SlashCommand[];
	/** Index into `commands` of the row Enter/Tab would accept. */
	activeIndex: number;
	onHighlight: (index: number) => void;
	onSelect: (name: string) => void;
};

/**
 * The composer's slash-command list: the Skills this Repo has enabled,
 * filtered by what's been typed after the `/`.
 *
 * Positioned absolutely above the composer box rather than in a portalled
 * popover on purpose — the anchor is the composer itself (already the right
 * width, right there in the layout), and focus must stay in the textarea the
 * whole time so typing keeps filtering. That rules out the focus-trapping
 * floating primitives; keyboard handling therefore lives on the textarea's
 * own `onKeyDown` and arrives here as `activeIndex`.
 *
 * Rendered only when non-empty, so no "no matches" state exists: a query that
 * matches nothing closes the menu and leaves the user typing an ordinary
 * message that happens to start with a slash.
 */
export function SlashCommandMenu({
	commands,
	activeIndex,
	onHighlight,
	onSelect,
}: Props) {
	const listRef = useRef<HTMLDivElement>(null);

	// Keep the keyboard-selected row in view when arrowing past the scroll edge.
	useEffect(() => {
		const row = listRef.current?.children[activeIndex];
		row?.scrollIntoView({ block: "nearest" });
	}, [activeIndex]);

	return (
		<div className="absolute inset-x-0 bottom-full z-20 mb-1.5">
			<div
				ref={listRef}
				// A listbox owned by a textarea that keeps focus throughout, so the
				// rows are buttons rather than focusable options.
				role="listbox"
				aria-label="Skills"
				className="max-h-56 overflow-y-auto rounded-xl bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
			>
				{commands.map((command, index) => (
					<button
						key={command.name}
						type="button"
						role="option"
						aria-selected={index === activeIndex}
						// Pointer-down, not click: `click` lands after the textarea has
						// already lost focus and blur closes the menu, so the row would
						// be unmounted before its handler ran.
						onMouseDown={(e) => {
							e.preventDefault();
							onSelect(command.name);
						}}
						onMouseEnter={() => onHighlight(index)}
						className={cn(
							"flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
							index === activeIndex ? "bg-accent" : "bg-transparent",
						)}
					>
						<Sparkles className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
						<span className="min-w-0 flex-1">
							<span className="block font-medium text-sm">{command.name}</span>
							{command.description && (
								<span className="line-clamp-2 block text-muted-foreground text-xs">
									{command.description}
								</span>
							)}
						</span>
					</button>
				))}
			</div>
		</div>
	);
}
