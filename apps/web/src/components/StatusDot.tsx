import type { SessionView } from "@dilna/shared";

export function StatusDot({ status }: { status: SessionView["status"] }) {
	const color =
		status === "working"
			? "bg-emerald-500"
			: status === "starting" || status === "stopping"
				? "bg-amber-500"
				: status === "crashed"
					? "bg-red-500"
					: "bg-zinc-400";
	return <span className={`size-1.5 shrink-0 rounded-full ${color}`} />;
}
