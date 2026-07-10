import type { Repo, SessionView } from "@dilna/shared";
import { ChevronDown, FileDiff, FolderGit2, Menu, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { StatusDot } from "@/components/StatusDot";
import { UsageBadge } from "@/components/UsageBadge";
import type { MobileSheetTrigger } from "@/hooks/useMobileSheet";
import { AGENT_LABELS } from "@/lib/agent-labels";
import { cn } from "@/lib/utils";

type Props = {
	repo: Repo;
	sessions: SessionView[];
	selectedSession: SessionView | null;
	onSelectSession: (session: SessionView) => void;
	onDeleteSession: (id: string) => void;
	/** Below the 768px breakpoint (issue #12) these drive the shared mobile
	 * bottom sheet in place of the desktop Sidebar/ContextPanel; hidden via
	 * `md:hidden` above the breakpoint, where the desktop panels are always
	 * visible instead. */
	menuTrigger: MobileSheetTrigger;
	filesTrigger: MobileSheetTrigger;
};

export function ChatHeader({
	repo,
	sessions,
	selectedSession,
	onSelectSession,
	onDeleteSession,
	menuTrigger,
	filesTrigger,
}: Props) {
	return (
		<header className="relative z-[60] flex h-14 items-center gap-2 border-b border-border bg-background px-4">
			<MobileMenuButton trigger={menuTrigger} />
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
					<button
						ref={filesTrigger.ref}
						type="button"
						onClick={filesTrigger.onToggle}
						aria-label="Toggle changed files"
						aria-pressed={filesTrigger.open}
						className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
					>
						<FileDiff className="size-4" />
					</button>
					<span className="hidden rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground md:inline">
						Agent · {AGENT_LABELS[selectedSession.agentType]}
					</span>
					<button
						type="button"
						onClick={() => onDeleteSession(selectedSession.id)}
						title="Delete session"
						className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
					>
						<Trash2 className="size-3.5" />
					</button>
				</div>
			)}
		</header>
	);
}

/** Shared with App.tsx's no-repo-selected fallback header, so the menu icon
 * that opens the mobile sheet's Repos & Sessions content looks and behaves
 * identically whether or not a repo is selected yet. */
export function MobileMenuButton({ trigger }: { trigger: MobileSheetTrigger }) {
	return (
		<button
			ref={trigger.ref}
			type="button"
			onClick={trigger.onToggle}
			aria-label="Toggle menu"
			aria-pressed={trigger.open}
			className="-ml-1.5 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
		>
			<Menu className="size-4" />
		</button>
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
				className="flex items-center gap-1.5 rounded-md border border-border bg-secondary/50 px-2.5 py-1 text-sm font-medium transition-colors hover:bg-accent"
			>
				{selectedSession ? selectedSession.title : "Select a session"}
				<ChevronDown className="size-3.5 text-muted-foreground" />
			</button>
			{open && (
				<div className="absolute left-0 top-full z-10 mt-1 max-h-80 w-72 overflow-y-auto rounded-md border border-border bg-popover py-1 shadow-lg">
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
									"flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-sm transition-colors hover:bg-accent/50",
									s.id === selectedSession?.id && "bg-accent/70",
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
