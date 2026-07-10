import type { RateLimitWindow, Repo, SessionView } from "@dilna/shared";
import { FolderGit2, Plus, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
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

const IS_MAC =
	typeof navigator !== "undefined" &&
	/Mac|iPod|iPhone|iPad/.test(navigator.platform);
const NEW_SESSION_SHORTCUT = IS_MAC ? "⌘K" : "Ctrl K";

type Props = {
	repos: Repo[];
	loadingRepos: boolean;
	error: string | null;
	selectedRepoId: string | null;
	onSelectRepo: (id: string) => void;
	onRefreshRepos: () => void;
	onNewRepo: () => void;
	onNewSession: () => void;
	creatingSession: boolean;
	backgroundSessions: SessionView[];
	repoSlugById: Record<string, string>;
	onSelectBackgroundSession: (session: SessionView) => void;
	/** Account-wide plan rate-limit windows (per ADR-0006-adjacent design in
	 * the "Account-wide plan rate-limit footer" issue). Empty/absent when
	 * unavailable — e.g. API-key auth, or no live Session has reported yet —
	 * in which case the footer renders nothing at all. */
	rateLimitWindows: RateLimitWindow[];
	/** Repo id → primary language name (from the repo stats fetch), for
	 * GitHub-style language icons in the repo list. Missing/undefined values
	 * fall back to the generic folder icon. */
	primaryLanguageByRepoId: Record<string, string | undefined>;
};

export function Sidebar({
	repos,
	loadingRepos,
	error,
	selectedRepoId,
	onSelectRepo,
	onRefreshRepos,
	onNewRepo,
	onNewSession,
	creatingSession,
	backgroundSessions,
	repoSlugById,
	onSelectBackgroundSession,
	rateLimitWindows,
	primaryLanguageByRepoId,
}: Props) {
	return (
		<aside className="flex w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar">
			<div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-4">
				<FolderGit2 className="size-5 text-muted-foreground" />
				<span className="font-semibold tracking-tight">dilna</span>
				<ThemeToggle className="ml-auto" />
			</div>

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
					<span className="ml-auto text-xs font-normal text-primary-foreground/60">
						{NEW_SESSION_SHORTCUT}
					</span>
				</button>
			</div>

			<ReposSection
				repos={repos}
				loading={loadingRepos}
				error={error}
				selectedRepoId={selectedRepoId}
				onSelectRepo={onSelectRepo}
				onRefresh={onRefreshRepos}
				onNew={onNewRepo}
				primaryLanguageByRepoId={primaryLanguageByRepoId}
			/>

			{/* Spacer keeps the Background Agents card pinned just above the
			    footer, matching the draft's floating-card placement. */}
			<div className="flex-1" />

			<BackgroundAgentsSection
				sessions={backgroundSessions}
				repoSlugById={repoSlugById}
				onSelect={onSelectBackgroundSession}
			/>

			<RateLimitFooter windows={rateLimitWindows} />
		</aside>
	);
}

function ReposSection({
	repos,
	loading,
	error,
	selectedRepoId,
	onSelectRepo,
	onRefresh,
	onNew,
	primaryLanguageByRepoId,
}: {
	repos: Repo[];
	loading: boolean;
	error: string | null;
	selectedRepoId: string | null;
	onSelectRepo: (id: string) => void;
	onRefresh: () => void;
	onNew: () => void;
	primaryLanguageByRepoId: Record<string, string | undefined>;
}) {
	return (
		<div className="flex flex-col">
			<SidebarSectionHeader
				title="Repositories"
				newTitle="New repository"
				onNew={onNew}
				onRefresh={onRefresh}
				refreshTitle="Pull latest default-branch changes"
			/>
			<div className="max-h-64 overflow-y-auto px-2 pb-2">
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
						{repos.map((repo) => (
							<li key={repo.id}>
								<button
									type="button"
									onClick={() => onSelectRepo(repo.id)}
									className={
										"flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors " +
										(repo.id === selectedRepoId
											? "bg-sidebar-accent font-medium"
											: "hover:bg-sidebar-accent/50")
									}
								>
									<LanguageIcon
										language={primaryLanguageByRepoId[repo.id]}
										className="size-4 shrink-0 text-muted-foreground"
									/>
									<span className="truncate">{repo.slug}</span>
									<span className="ml-auto shrink-0 text-[0.6875rem] text-muted-foreground/80">
										{repo.defaultBranch}
									</span>
								</button>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
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
}: {
	sessions: SessionView[];
	repoSlugById: Record<string, string>;
	onSelect: (session: SessionView) => void;
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
					{sessions.map((session) => (
						<li key={session.id}>
							<button
								type="button"
								onClick={() => onSelect(session)}
								className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent/50"
							>
								<span className="flex items-center gap-1.5 overflow-hidden">
									<StatusDot status={session.status} />
									<span className="truncate">{session.title}</span>
								</span>
								<span className="truncate pl-3 text-xs text-muted-foreground">
									{repoSlugById[session.repoId] ?? session.repoId}
								</span>
							</button>
						</li>
					))}
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
	refreshTitle = "Refresh",
}: {
	title: string;
	newTitle: string;
	onNew: () => void;
	onRefresh?: () => void;
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
						className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
						title={refreshTitle}
					>
						<RefreshCw className="size-3.5" />
					</button>
				)}
				<button
					type="button"
					onClick={onNew}
					className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
					title={newTitle}
				>
					<Plus className="size-3.5" />
				</button>
			</div>
		</div>
	);
}
