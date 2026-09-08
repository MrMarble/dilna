import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Writes `text` to the clipboard, falling back to a hidden <textarea> +
 * `execCommand("copy")` where `navigator.clipboard` is unavailable — it is
 * gated on a secure context, and dilna is routinely self-hosted behind plain
 * HTTP on a LAN address, where the modern API simply isn't there. */
async function writeClipboard(text: string): Promise<boolean> {
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// Permission denied / non-secure context: fall through to the shim.
		}
	}
	try {
		const area = document.createElement("textarea");
		area.value = text;
		// Keep it off-screen but still focusable, or the copy is a no-op.
		area.setAttribute("readonly", "");
		area.style.position = "fixed";
		area.style.top = "-9999px";
		document.body.appendChild(area);
		area.select();
		const ok = document.execCommand("copy");
		document.body.removeChild(area);
		return ok;
	} catch {
		return false;
	}
}

/** Icon button that copies `getText()` on click and flips to a checkmark for
 * a moment. `getText` is called at click time rather than taking a plain
 * string so a streaming message copies whatever it holds *now*. */
export function CopyButton({
	getText,
	label = "Copy",
	className,
}: {
	getText: () => string;
	label?: string;
	className?: string;
}) {
	const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => () => clearTimeout(timer.current), []);

	const handleClick = async () => {
		const ok = await writeClipboard(getText());
		setState(ok ? "copied" : "failed");
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setState("idle"), 1500);
	};

	return (
		<button
			type="button"
			onClick={handleClick}
			title={state === "failed" ? "Copy failed" : label}
			aria-label={label}
			className={cn(
				"rounded-md p-1 text-muted-foreground transition-[background-color,color,scale] hover:bg-accent hover:text-foreground active:scale-90 active:bg-accent",
				className,
			)}
		>
			{state === "copied" ? (
				<Check className="size-3.5" />
			) : (
				<Copy className="size-3.5" />
			)}
			<span className="sr-only" role="status">
				{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : ""}
			</span>
		</button>
	);
}
