import type { SessionView } from "@dilna/shared";

/**
 * A Session's status as a coloured dot.
 *
 * The colours come from the semantic tokens in `index.css` rather than raw
 * Tailwind palette classes, so a theme change moves them with everything else —
 * and so "idle" stops being `bg-zinc-400` (a fixed grey that read as a foreign
 * element against this app's cool-tinted neutrals).
 *
 * `working` additionally carries a soft halo, which is the one place status is
 * allowed to draw the eye: a Session the user is waiting on is the thing worth
 * noticing at a glance in a list of many.
 */
export function StatusDot({
	status,
	className = "",
}: {
	status: SessionView["status"];
	className?: string;
}) {
	const color =
		status === "working"
			? "bg-success ring-[2.5px] ring-success/20"
			: status === "starting" || status === "stopping"
				? "bg-warning"
				: status === "crashed"
					? "bg-danger"
					: "bg-idle";
	return (
		<span
			className={`size-1.5 shrink-0 rounded-full ${color} ${className}`}
			aria-hidden="true"
		/>
	);
}
