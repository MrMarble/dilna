import type {
	RateLimitWindow,
	Repo,
	RepoSyncStatus,
	SessionView,
} from "@dilna/shared";
import {
	ArrowDown,
	ArrowUp,
	BarChart3,
	Bell,
	BellOff,
	ChevronRight,
	FolderGit2,
	LoaderCircle,
	PanelLeftClose,
	Plus,
	RefreshCw,
	Settings,
	Sparkles,
	Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { AppVersion } from "@/components/AppVersion";
import { StatusDot } from "@/components/StatusDot";
import { ThemeToggle } from "@/components/ThemeToggle";
import { LanguageIcon } from "@/lib/languages";
import {
	formatTimeToReset,
	isRateLimitWindowFresh,
	RATE_LIMIT_LABELS,
	RATE_LIMIT_ORDER,
	rateLimitBarColor,
	rateLimitTooltip,
} from "@/lib/rate-limits";
import { cn } from "@/lib/utils";

const IS_MAC =
	typeof navigator !== "undefined" &&
	/Mac|iPod|iPhone|iPad/.test(navigator.platform);
const NEW_SESSION_SHORTCUT = IS_MAC ? "⌘K" : "Ctrl K";

/** Stable identity so an omitted `deletingSessionIds` doesn't allocate a new
 * array (and re-render every memoized child) on each render. */
const EMPTY_IDS: string[] = [];

/** Shared "this Session is being deleted" treatment for every session row
 * (per-repo submenu, orchestrator, background card, mobile current-session).
 * Destructive-tinted and non-interactive: the row is about to vanish, so
 * hover/selection styling would be misleading and clicking into it pointless.
 */
const DELETING_ROW_CLASS =
	"animate-pulse cursor-not-allowed bg-destructive/15 text-destructive hover:bg-destructive/15 hover:text-destructive";

type Props = {
	repos: Repo[];
	loadingRepos: boolean;
	error: string | null;
	selectedRepoId: string | null;
	onSelectRepo: (id: string) => void;
	onRefreshRepos: () => void;
	/** True while the "fetch changes" pull is in flight (it takes seconds —
	 * a network fetch per repo). Spins the refresh icon and blocks a second
	 * concurrent pull. */
	refreshingRepos?: boolean;
	onNewRepo: () => void;
	onNewSession: () => void;
	creatingSession: boolean;
	/** The Session open in the chat, if any — highlighted in the selected
	 * repo's session submenu. */
	selectedSessionId: string | null;
	/** Repo id → its Sessions (newest-active first), for the per-repo
	 * expandable submenu — only the selected repo's list is ever rendered,
	 * but every repo's is available so switching repos doesn't need a
	 * fetch. */
	sessionsByRepoId: Record<string, SessionView[]>;
	backgroundSessions: SessionView[];
	repoSlugById: Record<string, string>;
	/** Used both for the per-repo session submenu and the Background Agents
	 * card — selecting a Session means the same thing everywhere. */
	onSelectSession: (session: SessionView) => void;
	/** Account-wide plan rate-limit windows (per ADR-0006-adjacent design in
	 * the "Account-wide plan rate-limit footer" issue). Empty/absent when
	 * unavailable — e.g. API-key auth, or no live Session has reported yet —
	 * in which case the footer renders nothing at all. */
	rateLimitWindows: RateLimitWindow[];
	/** Repo id → primary language name (from the repo stats fetch), for
	 * GitHub-style language icons in the repo list. Missing/undefined values
	 * fall back to the generic folder icon. */
	primaryLanguageByRepoId: Record<string, string | undefined>;
	/** Repo id → ahead/behind vs `origin`, from the periodic client-side sync
	 * check (see App.tsx). Missing entry just means no check has landed yet
	 * (or it failed) — renders no badge, not a stale one. */
	syncStatusByRepoId: Record<string, RepoSyncStatus | undefined>;
	/** "panel" (default) is the desktop always-visible aside. "sheet" strips
	 * the outer width/border/brand chrome for use inside the mobile bottom
	 * sheet (issue #12) and pins the rate-limit footer below a scrollable
	 * region instead of via the desktop flex-spacer trick, since the sheet's
	 * height is bounded rather than always matching the full viewport. */
	variant?: "panel" | "sheet";
	/** The Session currently open in the chat, with its delete handler —
	 * shown as a quick-action row in the sheet variant only, so mobile users
	 * can delete the active Session without a "Delete session" button
	 * crowding the header (issue #12 follow-up). Desktop keeps deletion in
	 * ChatHeader instead; both are absent/no-op here when there's no
	 * Session open yet. */
	currentSession?: SessionView | null;
	onDeleteCurrentSession?: (id: string) => void;
	/** Desktop-only collapse button in the panel's top bar (issue: sidebar
	 * can't be collapsed, squeezing the chat on non-mobile narrow viewports).
	 * Absent in the sheet variant, which closes via the drawer instead. */
	onCollapse?: () => void;
	/** Opens the Metrics dashboard (`MetricsPage`) in place of the chat. */
	onOpenMetrics: () => void;
	/** Opens the LLM provider/model Settings view in place of the chat. */
	onOpenSettings: () => void;
	/** Opens the Skills management view in place of the chat. */
	onOpenSkills: () => void;
	/** Orchestrator Sessions (ADR-0021), newest-active first — a top-level
	 * section, not nested under a repo, since the orchestrator is global. */
	orchestratorSessions: SessionView[];
	onNewOrchestratorSession: () => void;
	creatingOrchestrator: boolean;
	onSelectOrchestratorSession: (session: SessionView) => void;
	/** Per-session completed-turn counts (issue #52) — session id → how many
	 * turns finished while that session wasn't focused. Rendered as small
	 * badges on the session rows. Absent ids mean 0/read. */
	unreadBySessionId: Record<string, number>;
	/** Sessions with a delete in flight. Deleting takes up to ~10s server-side
	 * (agent teardown + ADR-0024 archive + worktree removal), so the row stays
	 * rendered but highlighted destructive-red until it disappears, instead of
	 * looking like the click never registered. */
	deletingSessionIds?: string[];
	/** Whether background push delivery is available/active (ADR-0029) — only
	 * used for the bell's tooltip, so "on" can't imply a capability the
	 * browser doesn't have. */
	pushSupported?: boolean;
	pushSubscribed?: boolean;
	/** Whether browser Notifications are enabled (issue #52). Drives the
	 * bell's state and tooltip. */
	notificationsEnabled: boolean;
	toggleNotifications: () => Promise<boolean>;
};

export function Sidebar({
	repos,
	loadingRepos,
	error,
	selectedRepoId,
	onSelectRepo,
	onRefreshRepos,
	refreshingRepos = false,
	onNewRepo,
	onNewSession,
	creatingSession,
	selectedSessionId,
	sessionsByRepoId,
	backgroundSessions,
	repoSlugById,
	onSelectSession,
	rateLimitWindows,
	primaryLanguageByRepoId,
	syncStatusByRepoId,
	variant = "panel",
	currentSession,
	onDeleteCurrentSession,
	onCollapse,
	onOpenMetrics,
	onOpenSettings,
	onOpenSkills,
	orchestratorSessions,
	onNewOrchestratorSession,
	creatingOrchestrator,
	onSelectOrchestratorSession,
	unreadBySessionId,
	deletingSessionIds,
	notificationsEnabled,
	toggleNotifications,
	pushSupported,
	pushSubscribed,
}: Props) {
	const isSheet = variant === "sheet";
	const deletingIds = deletingSessionIds ?? EMPTY_IDS;
	const totalUnread = Object.values(unreadBySessionId).reduce(
		(a, b) => a + b,
		0,
	);
	return (
		<aside
			className={cn(
				"flex flex-col",
				isSheet
					? "min-h-0 flex-1"
					: "w-64 shrink-0 border-r border-sidebar-border bg-sidebar",
			)}
		>
			{!isSheet && (
				<div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-4">
					<FolderGit2 className="size-5 text-muted-foreground" />
					<span className="font-semibold tracking-tight">dilna</span>
					<AppVersion />
					<NotificationsToggle
						onClick={toggleNotifications}
						enabled={notificationsEnabled}
						unreadTotal={totalUnread}
						pushSupported={pushSupported}
						pushSubscribed={pushSubscribed}
						className="ml-auto"
					/>
					<ThemeToggle />
					{onCollapse && (
						<button
							type="button"
							onClick={onCollapse}
							title="Collapse sidebar"
							className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
						>
							<PanelLeftClose className="size-4" />
						</button>
					)}
				</div>
			)}

			<div
				className={cn(
					"flex flex-1 flex-col",
					isSheet && "min-h-0 overflow-y-auto",
				)}
			>
				<div className="border-b border-sidebar-border p-2">
					<button
						type="button"
						onClick={onNewSession}
						disabled={!selectedRepoId || creatingSession}
						title={
							selectedRepoId
								? "New session"
								: "Select a repository to start a session"
						}
						className="flex w-full items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-[background-color,scale] hover:bg-primary/90 active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
					>
						<Plus className="size-3.5" />
						{creatingSession ? "Creating…" : "New session"}
						<span className="ml-auto hidden text-xs font-normal text-primary-foreground/60 md:inline">
							{NEW_SESSION_SHORTCUT}
						</span>
					</button>
					<button
						type="button"
						onClick={onOpenMetrics}
						className="mt-1 flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/40 hover:text-foreground active:bg-sidebar-accent/70"
					>
						<BarChart3 className="size-3.5 shrink-0" />
						Metrics
					</button>
					<button
						type="button"
						onClick={onOpenSkills}
						className="mt-0.5 flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/40 hover:text-foreground active:bg-sidebar-accent/70"
					>
						<Sparkles className="size-3.5 shrink-0" />
						Skills
					</button>
					<button
						type="button"
						onClick={onOpenSettings}
						className="mt-0.5 flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent/40 hover:text-foreground active:bg-sidebar-accent/70"
					>
						<Settings className="size-3.5 shrink-0" />
						Settings
					</button>
				</div>

				{isSheet && currentSession && onDeleteCurrentSession && (
					<CurrentSessionRow
						session={currentSession}
						onDelete={onDeleteCurrentSession}
						deleting={deletingIds.includes(currentSession.id)}
					/>
				)}

				{isSheet && (
					<div className="flex items-center justify-between border-b border-sidebar-border px-4 py-2">
						<NotificationsToggle
							onClick={toggleNotifications}
							enabled={notificationsEnabled}
							unreadTotal={totalUnread}
							pushSupported={pushSupported}
							pushSubscribed={pushSubscribed}
						/>
						<span className="text-xs text-muted-foreground">
							{totalUnread > 0
								? `${totalUnread} finished turn${totalUnread === 1 ? "" : "s"}`
								: "no new turns"}
						</span>
					</div>
				)}

				<OrchestratorSection
					sessions={orchestratorSessions}
					selectedSessionId={selectedSessionId}
					creating={creatingOrchestrator}
					onNew={onNewOrchestratorSession}
					onSelect={onSelectOrchestratorSession}
					unreadBySessionId={unreadBySessionId}
					deletingIds={deletingIds}
				/>

				<ReposSection
					repos={repos}
					loading={loadingRepos}
					error={error}
					selectedRepoId={selectedRepoId}
					selectedSessionId={selectedSessionId}
					sessionsByRepoId={sessionsByRepoId}
					onSelectRepo={onSelectRepo}
					onSelectSession={onSelectSession}
					onRefresh={onRefreshRepos}
					refreshing={refreshingRepos}
					onNew={onNewRepo}
					primaryLanguageByRepoId={primaryLanguageByRepoId}
					syncStatusByRepoId={syncStatusByRepoId}
					unreadBySessionId={unreadBySessionId}
					deletingIds={deletingIds}
					isSheet={isSheet}
				/>

				<BackgroundAgentsSection
					sessions={backgroundSessions}
					repoSlugById={repoSlugById}
					onSelect={onSelectSession}
					unreadBySessionId={unreadBySessionId}
					deletingIds={deletingIds}
				/>
			</div>

			<RateLimitFooter windows={rateLimitWindows} />
		</aside>
	);
}

function CurrentSessionRow({
	session,
	onDelete,
	deleting,
}: {
	session: SessionView;
	onDelete: (id: string) => void;
	deleting: boolean;
}) {
	return (
		<div
			className={cn(
				"flex items-center gap-2 border-b border-sidebar-border px-4 py-2",
				deleting && "animate-pulse bg-destructive/15 text-destructive",
			)}
		>
			<StatusDot status={session.status} />
			<span className="min-w-0 flex-1 truncate text-sm font-medium">
				{session.title}
			</span>
			<button
				type="button"
				onClick={() => onDelete(session.id)}
				disabled={deleting}
				title={deleting ? "Deleting session…" : "Delete session"}
				className={cn(
					"shrink-0 rounded-md p-2.5 transition-[background-color,color,scale]",
					deleting
						? "cursor-not-allowed text-destructive"
						: "text-muted-foreground hover:bg-accent hover:text-destructive active:scale-90 active:bg-accent active:text-destructive",
				)}
			>
				{deleting ? (
					<LoaderCircle className="size-3.5 animate-spin" />
				) : (
					<Trash2 className="size-3.5" />
				)}
			</button>
		</div>
	);
}

/**
 * The orchestrator's own top-level section (ADR-0021) — not nested under a
 * repo, since it's global rather than per-repo. Always visible (there's no
 * per-repo grouping to collapse, unlike ReposSection's accordion); renders
 * just the "+" and no list when there are no orchestrator Sessions yet.
 */
function OrchestratorSection({
	sessions,
	selectedSessionId,
	creating,
	onNew,
	onSelect,
	unreadBySessionId,
	deletingIds,
}: {
	sessions: SessionView[];
	selectedSessionId: string | null;
	creating: boolean;
	onNew: () => void;
	onSelect: (session: SessionView) => void;
	unreadBySessionId: Record<string, number>;
	deletingIds: string[];
}) {
	return (
		<div className="border-b border-sidebar-border">
			<SidebarSectionHeader
				title="Orchestrator"
				newTitle={creating ? "Creating…" : "New orchestrator chat"}
				onNew={onNew}
			/>
			{sessions.length > 0 && (
				<ul className="space-y-0.5 px-2 pb-2">
					{sessions.map((session) => {
						const deleting = deletingIds.includes(session.id);
						return (
							<li key={session.id}>
								<button
									type="button"
									onClick={() => onSelect(session)}
									disabled={deleting}
									title={deleting ? "Deleting session…" : undefined}
									className={cn(
										"flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
										session.id === selectedSessionId
											? "bg-sidebar-accent font-medium text-foreground"
											: "text-muted-foreground hover:bg-sidebar-accent/40 hover:text-foreground active:bg-sidebar-accent/70",
										deleting && DELETING_ROW_CLASS,
									)}
								>
									<StatusDot status={session.status} />
									<Sparkles className="size-3.5 shrink-0" />
									<span className="truncate">{session.title}</span>
									{deleting ? (
										<LoaderCircle className="ml-auto size-3 shrink-0 animate-spin" />
									) : (
										<UnreadBadge count={unreadBySessionId[session.id] ?? 0} />
									)}
								</button>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
}

/**
 * Repos as a single-open accordion: clicking a repo selects it (which — per
 * App's handleSelectRepo — also jumps to its latest Session) and expands its
 * Session submenu in place, collapsing whichever repo was expanded before.
 * Re-clicking the already-selected repo's row is a no-op rather than
 * re-running the "jump to latest" logic, so it doesn't clobber a Session the
 * user explicitly picked from the submenu. This replaces the old header
 * dropdown as the only way to switch Sessions (see ChatHeader).
 */
function ReposSection({
	repos,
	loading,
	error,
	selectedRepoId,
	selectedSessionId,
	sessionsByRepoId,
	onSelectRepo,
	onSelectSession,
	onRefresh,
	refreshing,
	onNew,
	primaryLanguageByRepoId,
	syncStatusByRepoId,
	unreadBySessionId,
	deletingIds,
	isSheet,
}: {
	repos: Repo[];
	loading: boolean;
	error: string | null;
	selectedRepoId: string | null;
	selectedSessionId: string | null;
	sessionsByRepoId: Record<string, SessionView[]>;
	onSelectRepo: (id: string) => void;
	onSelectSession: (session: SessionView) => void;
	onRefresh: () => void;
	refreshing: boolean;
	onNew: () => void;
	primaryLanguageByRepoId: Record<string, string | undefined>;
	syncStatusByRepoId: Record<string, RepoSyncStatus | undefined>;
	unreadBySessionId: Record<string, number>;
	deletingIds: string[];
	isSheet: boolean;
}) {
	return (
		<div className={cn("flex flex-col", !isSheet && "min-h-0 flex-1")}>
			<SidebarSectionHeader
				title="Repositories"
				newTitle="New repository"
				onNew={onNew}
				onRefresh={onRefresh}
				refreshing={refreshing}
				refreshTitle="Pull latest default-branch changes"
			/>
			<div
				className={cn(
					"px-2 pb-2",
					isSheet ? undefined : "min-h-0 flex-1 overflow-y-auto",
				)}
			>
				{loading && repos.length === 0 ? (
					<RepoListSkeleton />
				) : error ? (
					<p className="px-2 py-2 text-sm text-destructive">{error}</p>
				) : repos.length === 0 ? (
					<p className="px-2 py-2 text-sm text-muted-foreground">
						No repos. Click + to clone one.
					</p>
				) : (
					<ul className="space-y-0.5">
						{repos.map((repo) => {
							const expanded = repo.id === selectedRepoId;
							return (
								<li key={repo.id}>
									<button
										type="button"
										onClick={() => {
											if (!expanded) onSelectRepo(repo.id);
										}}
										aria-expanded={expanded}
										className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors hover:bg-sidebar-accent/40 active:bg-sidebar-accent/70"
									>
										<ChevronRight
											className={cn(
												"size-3.5 shrink-0 text-muted-foreground transition-transform",
												expanded && "rotate-90",
											)}
										/>
										<LanguageIcon
											language={primaryLanguageByRepoId[repo.id]}
											className="size-4 shrink-0 text-muted-foreground"
										/>
										<span className="truncate font-medium">{repo.slug}</span>
										<span className="ml-auto shrink-0 text-[0.6875rem] text-muted-foreground/80">
											{repo.defaultBranch}
										</span>
										<SyncBadge status={syncStatusByRepoId[repo.id]} />
									</button>
									{expanded && (
										<RepoSessionsSubmenu
											sessions={sessionsByRepoId[repo.id] ?? []}
											selectedSessionId={selectedSessionId}
											onSelect={onSelectSession}
											unreadBySessionId={unreadBySessionId}
											deletingIds={deletingIds}
										/>
									)}
								</li>
							);
						})}
					</ul>
				)}
			</div>
		</div>
	);
}

function RepoSessionsSubmenu({
	sessions,
	selectedSessionId,
	onSelect,
	unreadBySessionId,
	deletingIds,
}: {
	sessions: SessionView[];
	selectedSessionId: string | null;
	onSelect: (session: SessionView) => void;
	unreadBySessionId: Record<string, number>;
	deletingIds: string[];
}) {
	if (sessions.length === 0) {
		return (
			<div className="ml-[19px] border-l border-muted-foreground/25 py-1.5 pl-3">
				<p className="text-xs text-muted-foreground">No sessions yet.</p>
			</div>
		);
	}
	return (
		<ul className="ml-[19px] space-y-0.5 border-l border-muted-foreground/25 py-0.5 pl-3">
			{sessions.map((session) => {
				const deleting = deletingIds.includes(session.id);
				return (
					<li key={session.id}>
						<button
							type="button"
							onClick={() => onSelect(session)}
							disabled={deleting}
							title={deleting ? "Deleting session…" : undefined}
							className={cn(
								"flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
								session.id === selectedSessionId
									? "bg-sidebar-accent font-medium text-foreground"
									: "text-muted-foreground hover:bg-sidebar-accent/40 hover:text-foreground",
								deleting && DELETING_ROW_CLASS,
							)}
						>
							<StatusDot status={session.status} />
							<span className="truncate">{session.title}</span>
							{deleting ? (
								<LoaderCircle className="ml-auto size-3 shrink-0 animate-spin" />
							) : (
								<UnreadBadge count={unreadBySessionId[session.id] ?? 0} />
							)}
						</button>
					</li>
				);
			})}
		</ul>
	);
}

/** VS Code-style "N to pull" / "N to push" indicator next to a repo's default
 * branch. Renders nothing when there's nothing to show — no status yet, or
 * the local ref is already caught up with `origin`. */
function SyncBadge({ status }: { status: RepoSyncStatus | undefined }) {
	if (!status || (status.ahead === 0 && status.behind === 0)) return null;
	return (
		<span
			className="ml-1 flex shrink-0 items-center gap-0.5 text-[0.6875rem] text-muted-foreground/80"
			title={`${status.behind} commit${status.behind === 1 ? "" : "s"} to pull, ${status.ahead} to push`}
		>
			{status.behind > 0 && (
				<span className="flex items-center gap-px">
					<ArrowDown className="size-3" />
					{status.behind}
				</span>
			)}
			{status.ahead > 0 && (
				<span className="flex items-center gap-px">
					<ArrowUp className="size-3" />
					{status.ahead}
				</span>
			)}
		</span>
	);
}

/**
 * Small count chip rendered against a session row (issue #52) when turns
 * finished while that session wasn't focused. Renders nothing when there are
 * none, so a read session stays visually clean.
 */
function UnreadBadge({ count }: { count: number }) {
	if (count <= 0) return null;
	return (
		<span
			className="ml-auto shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[0.6875rem] font-semibold leading-none text-primary-foreground"
			title={`${count} finished turn${count === 1 ? "" : "s"} while you weren't looking`}
		>
			{count}
		</span>
	);
}

/**
 * The header bell + notifications toggle (issue #52). Bell icon reflects
 * whether system Notifications are enabled; the badge shows the aggregate
 * unread count (also rendered, for mobile, next to the bell in the sheet
 * variant). Clicking fires the toggle, which requests OS permission on first
 * enable.
 */
function NotificationsToggle({
	onClick,
	enabled,
	unreadTotal,
	pushSupported,
	pushSubscribed,
	className,
}: {
	onClick: () => void;
	enabled: boolean;
	unreadTotal: number;
	pushSupported?: boolean;
	pushSubscribed?: boolean;
	className?: string;
}) {
	const Icon = enabled ? Bell : BellOff;
	const permission =
		typeof Notification !== "undefined"
			? Notification.permission
			: "unsupported";
	let title = "Notify me when a session's turn completes";
	if (enabled) {
		// "On" alone used to imply background delivery that may not exist — the
		// in-page Notification path needs a live tab, and on Android it doesn't
		// work at all (ADR-0029). Say which channel is actually active.
		if (pushSubscribed) {
			title =
				"Notifications on (background delivery active) — click to turn off";
		} else if (pushSupported === false) {
			title =
				"Notifications on, but this browser can't deliver them in the background — only while dilna is open";
		} else {
			title = "Turn off session-completion notifications";
		}
	} else if (permission === "denied") {
		title = "Notifications blocked in the browser — allow them to enable";
	}
	return (
		<button
			type="button"
			onClick={onClick}
			title={title}
			className={cn(
				"relative rounded-md p-2.5 text-muted-foreground transition-[background-color,color,scale] hover:bg-sidebar-accent hover:text-foreground active:scale-90 active:bg-sidebar-accent",
				className,
			)}
		>
			<Icon className="size-4" />
			{unreadTotal > 0 && (
				<span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[0.625rem] font-semibold leading-none text-primary-foreground">
					{unreadTotal}
				</span>
			)}
		</button>
	);
}

/** Shape-matched placeholder rows shown while the initial repo list loads. */
function RepoListSkeleton() {
	return (
		<div className="flex flex-col gap-1 px-2 py-1" aria-hidden="true">
			{[0, 1, 2].map((i) => (
				<div
					key={i}
					className="flex animate-pulse items-center gap-2 px-1 py-1.5"
				>
					<div className="size-4 shrink-0 rounded bg-sidebar-accent/70" />
					<div
						className="h-3 rounded bg-sidebar-accent/70"
						style={{ width: `${72 - i * 14}%` }}
					/>
				</div>
			))}
		</div>
	);
}

/**
 * Floating card pinned above the sidebar footer (per the ui_draft mock),
 * rather than a permanent section: it renders nothing at all when no other
 * session is active, instead of an empty shell with placeholder text.
 */
function BackgroundAgentsSection({
	sessions,
	repoSlugById,
	onSelect,
	unreadBySessionId,
	deletingIds,
}: {
	sessions: SessionView[];
	repoSlugById: Record<string, string>;
	onSelect: (session: SessionView) => void;
	unreadBySessionId: Record<string, number>;
	deletingIds: string[];
}) {
	if (sessions.length === 0) return null;

	return (
		<div className="mx-2 mb-2 flex max-h-64 flex-col overflow-hidden rounded-xl border border-sidebar-border bg-card shadow-sm">
			<div className="flex items-center justify-between px-3 py-2">
				<span className="text-xs font-medium text-muted-foreground">
					Background Agents
				</span>
				<span className="rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
					{sessions.length}
				</span>
			</div>
			<div className="overflow-y-auto px-1.5 pb-1.5">
				<ul className="space-y-0.5">
					{sessions.map((session) => {
						const deleting = deletingIds.includes(session.id);
						return (
							<li key={session.id}>
								<button
									type="button"
									onClick={() => onSelect(session)}
									disabled={deleting}
									title={deleting ? "Deleting session…" : undefined}
									className={cn(
										"flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/50 active:bg-accent/80",
										deleting && DELETING_ROW_CLASS,
									)}
								>
									<span className="flex items-center gap-1.5 overflow-hidden">
										<StatusDot status={session.status} />
										<span className="truncate">{session.title}</span>
										{deleting ? (
											<LoaderCircle className="ml-auto size-3 shrink-0 animate-spin" />
										) : (
											<UnreadBadge count={unreadBySessionId[session.id] ?? 0} />
										)}
									</span>
									<span className="truncate pl-3 text-xs text-muted-foreground">
										{repoSlugById[session.repoId] ?? session.repoId}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
			</div>
		</div>
	);
}

/**
 * Account-wide plan rate-limit footer. Entirely absent — not an empty or
 * disabled shell — whenever there's nothing fresh to show: API-key auth
 * never produces rate-limit data server-side (the SDK reports plan limits
 * only for claude.ai subscription sessions — see `agents/claude.ts`), and a
 * window whose reset time has passed with no live Session to refresh it is
 * treated the same as unavailable rather than shown frozen at its last
 * percentage.
 *
 * The 30s re-render tick below only recomputes staleness against
 * already-received `resetsAt` values — it makes no network request and
 * fetches no new data, so it isn't the "dedicated background poller" the
 * issue rules out; data only ever changes via a server push (the SDK's
 * post-turn usage pull or a `rate_limit_event`, both persisted server-side
 * and re-served as the SSE connect snapshot after a reload).
 */
function RateLimitFooter({ windows }: { windows: RateLimitWindow[] }) {
	const [nowMs, setNowMs] = useState(() => Date.now());

	useEffect(() => {
		if (windows.length === 0) return;
		const interval = setInterval(() => setNowMs(Date.now()), 30_000);
		return () => clearInterval(interval);
	}, [windows.length]);

	const fresh = RATE_LIMIT_ORDER.map((kind) =>
		windows.find((w) => w.kind === kind),
	).filter(
		(w): w is RateLimitWindow =>
			w !== undefined && isRateLimitWindowFresh(w, nowMs),
	);

	if (fresh.length === 0) return null;

	return (
		<div className="flex gap-3 border-t border-sidebar-border p-3">
			{fresh.map((window) => (
				<RateLimitBar key={window.kind} window={window} nowMs={nowMs} />
			))}
		</div>
	);
}

function RateLimitBar({
	window,
	nowMs,
}: {
	window: RateLimitWindow;
	nowMs: number;
}) {
	const pct = Math.max(0, Math.min(100, window.utilizationPct));
	return (
		<div className="min-w-0 flex-1" title={rateLimitTooltip(window, nowMs)}>
			<div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
				<span>{RATE_LIMIT_LABELS[window.kind]}</span>
				<span className="truncate pl-1 tabular-nums">
					{formatTimeToReset(window.resetsAt, nowMs)}
				</span>
			</div>
			<div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
				<div
					className={`h-full rounded-full ${rateLimitBarColor(pct)}`}
					style={{ width: `${pct}%` }}
				/>
			</div>
		</div>
	);
}

function SidebarSectionHeader({
	title,
	newTitle,
	onNew,
	onRefresh,
	refreshing = false,
	refreshTitle = "Refresh",
}: {
	title: string;
	newTitle: string;
	onNew: () => void;
	onRefresh?: () => void;
	/** Spins the refresh icon and disables the button while the fetch is in
	 * flight, so a multi-second pull doesn't look like a dead click. */
	refreshing?: boolean;
	refreshTitle?: string;
}) {
	return (
		<div className="flex items-center justify-between px-4 py-2">
			<span className="text-xs font-medium text-muted-foreground">{title}</span>
			<div className="flex items-center gap-0.5">
				{onRefresh && (
					<button
						type="button"
						onClick={onRefresh}
						disabled={refreshing}
						aria-busy={refreshing}
						className="rounded-md p-2.5 text-muted-foreground transition-[background-color,color,scale] hover:bg-sidebar-accent hover:text-foreground active:scale-90 active:bg-sidebar-accent disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
						title={refreshing ? "Fetching changes…" : refreshTitle}
					>
						<RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
					</button>
				)}
				<button
					type="button"
					onClick={onNew}
					className="rounded-md p-2.5 text-muted-foreground transition-[background-color,color,scale] hover:bg-sidebar-accent hover:text-foreground active:scale-90 active:bg-sidebar-accent"
					title={newTitle}
				>
					<Plus className="size-4" />
				</button>
			</div>
		</div>
	);
}
