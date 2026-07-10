import { useState } from "react";
import { cn } from "@/lib/utils";

function formatCommitDate(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	return date.toLocaleDateString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
	});
}

/** Version badge next to the "dilna" wordmark. Hover shows the commit hash
 * and date as a native tooltip; tapping toggles the same detail inline for
 * mobile, which has no hover state. */
export function AppVersion({ className }: { className?: string }) {
	const [expanded, setExpanded] = useState(false);
	const detail = `${__COMMIT_HASH__} · ${formatCommitDate(__COMMIT_DATE__)}`;

	return (
		<button
			type="button"
			onClick={() => setExpanded((v) => !v)}
			title={detail}
			className={cn(
				"max-w-24 shrink-0 truncate whitespace-nowrap rounded px-1 py-0.5 font-mono text-[10px] text-muted-foreground/70 transition-colors hover:text-muted-foreground",
				className,
			)}
		>
			{expanded ? detail : `v${__APP_VERSION__}`}
		</button>
	);
}
