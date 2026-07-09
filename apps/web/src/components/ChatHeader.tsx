import type { Repo, SessionView } from "@dilna/shared";
import { ChevronDown, FolderGit2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { StatusDot } from "@/components/StatusDot";
import { UsageBadge } from "@/components/UsageBadge";
import { AGENT_LABELS } from "@/lib/agent-labels";
import { cn } from "@/lib/utils";

type Props = {
	repo: Repo;
	sessions: SessionView[];
	selectedSession: SessionView | null;
	onSelectSession: (session: SessionView) => void;
	onDeleteSession: (id: string) => void;
};

export function ChatHeader({
	repo,
	sessions,
	selectedSession,
	onSelectSession,
	onDeleteSession,
}: Props) {
	return (
		<header className="flex h-14 items-center gap-2 border-b border-zinc-200 px-4 dark:border-zinc-800">
			<FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
			<span className="font-medium">{repo.slug}</span>
			<span className="text-muted-foreground">/</span>
			<SessionSwitcher
				sessions={sessions}
				selectedSession={selectedSession}
				onSelectSession={onSelectSession}
			/>
			{selectedSession && (
				<div className="ml-auto flex shrink-0 items-center gap-2">
					<UsageBadge key={selectedSession.id} sessionId={selectedSession.id} />
					<span className="rounded-full border border-zinc-200 px-2 py-0.5 text-xs text-muted-foreground dark:border-zinc-800">
						Agent · {AGENT_LABELS[selectedSession.agentType]}
					</span>
					<button
						type="button"
						onClick={() => onDeleteSession(selectedSession.id)}
						title="Delete session"
						className="rounded-md p-1.5 text-muted-foreground hover:bg-zinc-200 hover:text-red-500 dark:hover:bg-zinc-800"
					>
						<Trash2 className="size-3.5" />
					</button>
				</div>
			)}
		</header>
	);
}

function SessionSwitcher({
	sessions,
	selectedSession,
	onSelectSession,
}: {
	sessions: SessionView[];
	selectedSession: SessionView | null;
	onSelectSession: (session: SessionView) => void;
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		function onClick(e: MouseEvent) {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setOpen(false);
			}
		}
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") setOpen(false);
		}
		document.addEventListener("mousedown", onClick);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onClick);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex items-center gap-1 rounded-md px-2 py-1 text-sm font-medium hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50"
			>
				{selectedSession ? selectedSession.title : "Select a session"}
				<ChevronDown className="size-3.5 text-muted-foreground" />
			</button>
			{open && (
				<div className="absolute left-0 top-full z-10 mt-1 max-h-80 w-72 overflow-y-auto rounded-md border border-zinc-200 bg-white py-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-950">
					{sessions.length === 0 ? (
						<p className="px-3 py-2 text-sm text-muted-foreground">
							No sessions yet.
						</p>
					) : (
						sessions.map((s) => (
							<button
								key={s.id}
								type="button"
								onClick={() => {
									onSelectSession(s);
									setOpen(false);
								}}
								className={cn(
									"flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-sm hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50",
									s.id === selectedSession?.id &&
										"bg-zinc-200/70 dark:bg-zinc-800/70",
								)}
							>
								<StatusDot status={s.status} />
								<span className="truncate">{s.title}</span>
							</button>
						))
					)}
				</div>
			)}
		</div>
	);
}
