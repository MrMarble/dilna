import type { Repo, SessionView } from "@dilna/shared";
import {
	FileDiff,
	FolderGit2,
	Menu,
	PanelLeft,
	PanelRight,
	Trash2,
} from "lucide-react";
import { StatusDot } from "@/components/StatusDot";
import { UsageBadge } from "@/components/UsageBadge";
import type { MobileSheetTrigger } from "@/hooks/useMobileSheet";
import { AGENT_LABELS } from "@/lib/agent-labels";

type Props = {
	repo: Repo;
	selectedSession: SessionView | null;
	onDeleteSession: (id: string) => void;
	/** Below the 768px breakpoint (issue #12) these drive the shared mobile
	 * bottom sheet in place of the desktop Sidebar/ContextPanel; hidden via
	 * `md:hidden` above the breakpoint, where the desktop panels are always
	 * visible instead. */
	menuTrigger: MobileSheetTrigger;
	filesTrigger: MobileSheetTrigger;
	/** True when the desktop Sidebar is collapsed — shows a button here to
	 * bring it back, since collapsing it removes its own reopen affordance
	 * along with it. Always false on mobile, where the sheet's menu icon
	 * covers the same job. */
	sidebarCollapsed?: boolean;
	onExpandSidebar?: () => void;
	/** Same idea for the desktop ContextPanel. */
	contextCollapsed?: boolean;
	onExpandContext?: () => void;
};

/** Session switching lives in the Sidebar's per-repo submenu now (repos are
 * an accordion, Sessions are their sub-items) — this header just names where
 * you are, as plain (truncating) text, instead of doubling as another place
 * to switch Sessions from. */
export function ChatHeader({
	repo,
	selectedSession,
	onDeleteSession,
	menuTrigger,
	filesTrigger,
	sidebarCollapsed,
	onExpandSidebar,
	contextCollapsed,
	onExpandContext,
}: Props) {
	return (
		<header className="relative z-[60] flex h-14 items-center gap-2 border-b border-border bg-background px-4">
			<MobileMenuButton trigger={menuTrigger} />
			{sidebarCollapsed && onExpandSidebar && (
				<ExpandSidebarButton onClick={onExpandSidebar} />
			)}
			<div className="flex min-w-0 flex-1 items-center gap-2">
				<FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
				<span className="max-w-[40%] shrink-0 truncate font-medium">
					{repo.slug}
				</span>
				<span className="shrink-0 text-muted-foreground">/</span>
				{selectedSession ? (
					<span className="min-w-0 flex-1 truncate text-sm text-foreground">
						<StatusDot
							status={selectedSession.status}
							className="mr-1.5 inline-block align-middle"
						/>
						{selectedSession.title}
					</span>
				) : (
					<span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
						No session selected
					</span>
				)}
			</div>
			{selectedSession && (
				<div className="ml-auto flex shrink-0 items-center gap-2">
					<UsageBadge key={selectedSession.id} sessionId={selectedSession.id} />
					<button
						ref={filesTrigger.ref}
						type="button"
						onClick={filesTrigger.onToggle}
						aria-label="Toggle changed files"
						aria-pressed={filesTrigger.open}
						className="rounded-md p-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
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
						className="hidden rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive md:inline-flex"
					>
						<Trash2 className="size-3.5" />
					</button>
					{contextCollapsed && onExpandContext && (
						<button
							type="button"
							onClick={onExpandContext}
							title="Show context panel"
							className="hidden rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:inline-flex"
						>
							<PanelRight className="size-4" />
						</button>
					)}
				</div>
			)}
		</header>
	);
}

/** Reopens the collapsed desktop Sidebar — shown in ChatHeader and in App's
 * own no-repo-selected fallback header, since collapsing removes the
 * Sidebar's in-panel collapse button along with the rest of the panel. */
export function ExpandSidebarButton({ onClick }: { onClick: () => void }) {
	return (
		<button
			type="button"
			onClick={onClick}
			title="Show sidebar"
			className="hidden rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:inline-flex"
		>
			<PanelLeft className="size-4" />
		</button>
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
			className="-ml-2.5 rounded-md p-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
		>
			<Menu className="size-4" />
		</button>
	);
}
