import type {
	RateLimitWindow,
	RepoStats,
	RepoSyncStatus,
	SessionListEvent,
} from "@dilna/shared";
import { FolderGit2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Repo, type SessionView } from "@/api/client";
import { AppVersion } from "@/components/AppVersion";
import {
	ChatHeader,
	ExpandSidebarButton,
	MobileMenuButton,
} from "@/components/ChatHeader";
import { ChatShell } from "@/components/ChatShell";
import { ContextPanel } from "@/components/ContextPanel";
import { MetricsPage } from "@/components/MetricsPage";
import { NewRepoDialog } from "@/components/NewRepoDialog";
import { SettingsPage } from "@/components/SettingsPage";
import { Sidebar } from "@/components/Sidebar";
import { Drawer, DrawerContent } from "@/components/ui/drawer";
import { useIsDesktop } from "@/hooks/useIsDesktop";
import { useMobileSheet } from "@/hooks/useMobileSheet";
import { usePersistedBoolean } from "@/hooks/usePersistedBoolean";
import { useRoute } from "@/hooks/useRoute";
import { useSessionNotifications } from "@/hooks/useSessionNotifications";
import { isReservedSlug, type Route } from "@/lib/routes";

export function App() {
	const [repos, setRepos] = useState<Repo[]>([]);
	const [sessionsById, setSessionsById] = useState<Record<string, SessionView>>(
		{},
	);
	const [loadingRepos, setLoadingRepos] = useState(true);
	// Distinct from `loadingRepos` (the initial fetch) — see pullRepos.
	const [pullingRepos, setPullingRepos] = useState(false);
	const [repoError, setRepoError] = useState<string | null>(null);
	// The URL is the single source of truth for which view is showing and what
	// it's showing (see lib/routes.ts). Everything below derives from `route`
	// rather than tracking its own copy, which is what keeps deep links, back/
	// forward and refresh consistent for free — and what stops Metrics/Settings
	// from behaving like overlays that the sidebar can't navigate out of.
	const { route, navigate } = useRoute();

	// Which repo/session the route points at. Resolving the slug needs the
	// repo list, so until it lands `selectedRepo` is simply null and the app
	// renders its loading/empty state — no hydration flag or one-shot effect,
	// because re-deriving on every render is idempotent.
	const selectedRepo =
		route.kind === "repo"
			? (repos.find((r) => r.slug === route.repoSlug) ?? null)
			: null;
	const selectedRepoId = selectedRepo?.id ?? null;
	// Orchestrator Sessions are deliberately *not* attributed to a repo
	// (ADR-0021): their meta-repo is excluded from `repos`, so `selectedRepo`
	// stays null and ChatHeader/ContextPanel fall back to their no-repo
	// rendering for free.
	const selectedSessionId =
		route.kind === "orchestrator"
			? route.sessionId
			: route.kind === "repo" && selectedRepo
				? route.sessionId
				: null;
	const selectedSession = selectedSessionId
		? (sessionsById[selectedSessionId] ?? null)
		: null;

	const [newRepoOpen, setNewRepoOpen] = useState(false);
	const [creatingSession, setCreatingSession] = useState(false);
	const [rateLimitWindows, setRateLimitWindows] = useState<RateLimitWindow[]>(
		[],
	);
	const [statsByRepoId, setStatsByRepoId] = useState<Record<string, RepoStats>>(
		{},
	);
	const [syncStatusByRepoId, setSyncStatusByRepoId] = useState<
		Record<string, RepoSyncStatus>
	>({});
	// Below 768px the desktop Sidebar/ContextPanel aren't rendered at all
	// (rather than just hidden via CSS) so their SSE subscriptions don't run
	// twice alongside the mobile sheet's own instances — see issue #12.
	const isDesktop = useIsDesktop();
	const mobileSheet = useMobileSheet();
	const {
		handleSessionStatus,
		unreadBySessionId,
		markRead,
		forgetSession,
		notificationsEnabled,
		toggleNotifications,
	} = useSessionNotifications({ selectedSessionId });
	// Desktop-only: the Sidebar/ContextPanel are otherwise always-open fixed
	// columns that eat most of the width on a laptop-size (not phone-size)
	// viewport, squeezing the chat. Collapsing is per-panel and persisted so
	// it survives a reload.
	const [sidebarCollapsed, setSidebarCollapsed] = usePersistedBoolean(
		"dilna:sidebar-collapsed",
	);
	const [contextCollapsed, setContextCollapsed] = usePersistedBoolean(
		"dilna:context-collapsed",
	);

	// Crossing back over the breakpoint (window resize, tablet rotation) while
	// the sheet is open would otherwise leave it floating over the now-visible
	// desktop Sidebar/ContextPanel.
	useEffect(() => {
		if (isDesktop) mobileSheet.close();
	}, [isDesktop, mobileSheet.close]);

	const reloadRepos = useCallback(async () => {
		setLoadingRepos(true);
		setRepoError(null);
		try {
			const { repos } = await api.repos.list();
			setRepos(repos);
		} catch (e) {
			setRepoError(e instanceof Error ? e.message : "failed to load repos");
		} finally {
			setLoadingRepos(false);
		}
	}, []);

	// Sidebar's refresh button: pull every repo's default branch from its
	// origin remote (a bare clone otherwise has no way to pick up upstream
	// commits — see RepoManager.pull) before reloading the list. A repo whose
	// remote is unreachable shouldn't block the others from updating.
	//
	// Tracked by its own `pullingRepos` flag rather than `loadingRepos`: this
	// takes seconds (a network fetch per repo) and the sidebar already holds a
	// rendered repo list, so it drives a spinning refresh icon instead of the
	// initial-load skeleton, and guards against a second concurrent pull.
	const pullRepos = useCallback(async () => {
		if (pullingRepos) return;
		setPullingRepos(true);
		setRepoError(null);
		try {
			const results = await Promise.allSettled(
				repos.map((r) => api.repos.pull(r.id)),
			);
			const failed = results.filter((r) => r.status === "rejected").length;
			if (failed > 0) {
				setRepoError(
					`failed to pull ${failed} of ${results.length} repositor${results.length === 1 ? "y" : "ies"}`,
				);
			}
			try {
				const { repos: updated } = await api.repos.list();
				setRepos(updated);
			} catch (e) {
				setRepoError(e instanceof Error ? e.message : "failed to load repos");
			}
		} finally {
			setPullingRepos(false);
		}
	}, [repos, pullingRepos]);

	useEffect(() => {
		reloadRepos();
	}, [reloadRepos]);

	// Language/file stats per repo, for the sidebar icons and the context
	// panel. Refetched whenever the repo list changes (initial load, clone,
	// pull) — a failed repo just keeps its generic icon.
	useEffect(() => {
		let cancelled = false;
		for (const repo of repos) {
			api.repos
				.stats(repo.id)
				.then(({ stats }) => {
					if (cancelled) return;
					setStatsByRepoId((prev) => ({ ...prev, [repo.id]: stats }));
				})
				.catch(() => {});
		}
		return () => {
			cancelled = true;
		};
	}, [repos]);

	// Periodic "N commits behind" check per repo, VS Code-style — entirely
	// client-driven (no server-side timer) so the fetch only happens while
	// the app is open. Runs once whenever the repo list changes (covers the
	// initial load and right after a manual pull, since pullRepos ends by
	// replacing `repos`) and then every 3 minutes; a repo whose remote is
	// unreachable just keeps its last-known badge instead of clearing it.
	useEffect(() => {
		if (repos.length === 0) return;
		let cancelled = false;
		const checkAll = () => {
			for (const repo of repos) {
				api.repos
					.sync(repo.id)
					.then(({ status }) => {
						if (cancelled) return;
						setSyncStatusByRepoId((prev) => ({ ...prev, [repo.id]: status }));
					})
					.catch(() => {});
			}
		};
		checkAll();
		const interval = setInterval(checkAll, 3 * 60_000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [repos]);

	// Single cross-session status subscription (per ADR-0008) — the source
	// of truth for every session's live state, across every repo. Powers the
	// header's session dropdown and the sidebar's Background Agents panel.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the stream is opened once; handleSessionStatus/forgetSession are referentially stable (useCallback with no deps) and read mutable/selected state through refs, so listing them would needlessly reconnect the SSE stream.
	useEffect(() => {
		const unsubscribe = api.sessionList.stream((ev: SessionListEvent) => {
			if (ev.type === "session_status") {
				setSessionsById((prev) => ({ ...prev, [ev.session.id]: ev.session }));
				// Feed the turn-completion watcher (issue #52) — fires system
				// notifications and bumps the sidebar's unread badges for
				// sessions that finished while not focused.
				handleSessionStatus(ev.session);
			} else if (ev.type === "session_deleted") {
				setSessionsById((prev) => {
					if (!(ev.sessionId in prev)) return prev;
					const next = { ...prev };
					delete next[ev.sessionId];
					return next;
				});
				// A deleted session shouldn't keep a stale unread badge or keep
				// the bell's aggregate count inflated (issue #52).
				forgetSession(ev.sessionId);
			} else if (ev.type === "rate_limits") {
				setRateLimitWindows(ev.windows);
			}
		});
		return unsubscribe;
	}, []);

	// A deep link naming a repo that doesn't exist shouldn't leave a dead URL
	// in the bar. Only meaningful once the list has actually loaded — before
	// that, an unresolved slug just means "not fetched yet".
	useEffect(() => {
		if (loadingRepos || route.kind !== "repo") return;
		if (repos.some((r) => r.slug === route.repoSlug)) return;
		navigate({ kind: "home" }, { replace: true });
	}, [loadingRepos, repos, route, navigate]);

	// Selecting a Session marks it read (issue #52). Driven by the route
	// rather than by each individual click handler, so landing on a Session
	// via a deep link or the back button clears its badge too — it's on screen
	// either way.
	useEffect(() => {
		if (selectedSessionId) markRead(selectedSessionId);
	}, [selectedSessionId, markRead]);

	// Every repo's Sessions, newest-active first — the Sidebar's per-repo
	// submenu (issue: session switching moved out of the header dropdown and
	// into the sidebar) only ever renders the selected repo's list, but keeps
	// this pre-grouped so switching repos doesn't need a fetch or a re-filter
	// of every Session on every render. Orchestrator Sessions are excluded —
	// they live under the Sidebar's own top-level "Orchestrator" section, not
	// nested under the (hidden) meta-repo they technically belong to.
	const sessionsByRepoId = useMemo(() => {
		const map: Record<string, SessionView[]> = {};
		for (const session of Object.values(sessionsById)) {
			if (session.kind === "orchestrator") continue;
			let list = map[session.repoId];
			if (!list) {
				list = [];
				map[session.repoId] = list;
			}
			list.push(session);
		}
		for (const sessions of Object.values(map)) {
			sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
		}
		return map;
	}, [sessionsById]);

	const backgroundSessions = useMemo(
		() =>
			Object.values(sessionsById)
				.filter(
					(s) =>
						s.kind !== "orchestrator" &&
						s.id !== selectedSessionId &&
						s.status !== "idle",
				)
				.sort((a, b) => b.lastActiveAt - a.lastActiveAt),
		[sessionsById, selectedSessionId],
	);

	// The Sidebar's own top-level "Orchestrator" section — not nested under a
	// repo (it's global, ADR-0021), so it isn't part of sessionsByRepoId.
	const orchestratorSessions = useMemo(
		() =>
			Object.values(sessionsById)
				.filter((s) => s.kind === "orchestrator")
				.sort((a, b) => b.lastActiveAt - a.lastActiveAt),
		[sessionsById],
	);

	// The route for a repo-bound Session (or the repo's bare path when there's
	// no Session to land on). A repo whose slug collides with a standalone
	// view's path can't be addressed — pushing `/metrics` for a repo *named*
	// "metrics" would parse straight back to the Metrics page on reload — so
	// it falls back to home rather than producing a URL that lies.
	const repoRoute = useCallback(
		(repoId: string, sessionId: string | null): Route => {
			const repo = repos.find((r) => r.id === repoId);
			if (!repo || isReservedSlug(repo.slug)) return { kind: "home" };
			return { kind: "repo", repoSlug: repo.slug, sessionId };
		},
		[repos],
	);

	const handleSelectRepo = useCallback(
		(id: string) => {
			const latest = Object.values(sessionsById)
				.filter((s) => s.repoId === id)
				.sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
			navigate(repoRoute(id, latest?.id ?? null));
			// Only close the mobile sheet when the repo has a session to land
			// on — otherwise closing dumps the user on an empty state with no
			// visible "New session" affordance, forcing them to reopen the
			// sheet just to tap the button that's already right here.
			if (latest) mobileSheet.close();
		},
		[sessionsById, repoRoute, navigate, mobileSheet.close],
	);

	const handleSelectSession = useCallback(
		(session: SessionView) => {
			navigate(repoRoute(session.repoId, session.id));
			mobileSheet.close();
		},
		[repoRoute, navigate, mobileSheet.close],
	);

	// Orchestrator Sessions are global rather than repo-scoped (ADR-0021), so
	// they live at their own top-level path instead of under the hidden
	// meta-repo they technically belong to.
	const handleSelectOrchestratorSession = useCallback(
		(session: SessionView) => {
			navigate({ kind: "orchestrator", sessionId: session.id });
			mobileSheet.close();
		},
		[navigate, mobileSheet.close],
	);

	const handleSessionCreated = useCallback(
		(session: SessionView) => {
			setSessionsById((prev) => ({ ...prev, [session.id]: session }));
			navigate(repoRoute(session.repoId, session.id));
			mobileSheet.close();
		},
		[repoRoute, navigate, mobileSheet.close],
	);

	// No agent picker to confirm (Claude is the only backend), so "New
	// session" creates immediately rather than opening a dialog.
	const handleNewSession = useCallback(async () => {
		if (!selectedRepoId || creatingSession) return;
		setCreatingSession(true);
		try {
			const { session } = await api.sessions.create(selectedRepoId);
			handleSessionCreated(session);
		} catch (e) {
			console.error(e);
		} finally {
			setCreatingSession(false);
		}
	}, [selectedRepoId, creatingSession, handleSessionCreated]);

	// Sessions with a DELETE in flight — see handleDeleteSession.
	const [deletingSessionIds, setDeletingSessionIds] = useState<string[]>([]);

	const [creatingOrchestrator, setCreatingOrchestrator] = useState(false);
	const handleNewOrchestratorSession = useCallback(async () => {
		if (creatingOrchestrator) return;
		setCreatingOrchestrator(true);
		try {
			const { session } = await api.sessions.createOrchestrator();
			setSessionsById((prev) => ({ ...prev, [session.id]: session }));
			navigate({ kind: "orchestrator", sessionId: session.id });
			mobileSheet.close();
		} catch (e) {
			console.error(e);
		} finally {
			setCreatingOrchestrator(false);
		}
	}, [creatingOrchestrator, navigate, mobileSheet.close]);

	// Cmd/Ctrl+K creates a new session for the currently selected repo,
	// mirroring the sidebar button's shortcut hint. No-op with no repo
	// selected, same as the button's disabled state.
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				handleNewSession();
			}
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [handleNewSession]);

	// Deleting a Session is slow (up to ~10s: the agent is killed, the
	// Session is archived per ADR-0024 — an LLM summarization call — and the
	// worktree is removed), and until it resolves the row just sits there
	// looking untouched. Rather than optimistically dropping the row (which
	// would silently "succeed" on failure, and lose the Session from the UI
	// while its agent is still being torn down), keep it rendered and mark it
	// pending: the Sidebar highlights it in red, and a second click is a
	// no-op. The id is cleared on failure so the row returns to normal, and
	// on success too — harmlessly, since the row is gone by then.
	const handleDeleteSession = useCallback(
		async (id: string) => {
			if (deletingSessionIds.includes(id)) return;
			setDeletingSessionIds((prev) => [...prev, id]);
			try {
				await api.sessions.delete(id);
				setSessionsById((prev) => {
					if (!(id in prev)) return prev;
					const next = { ...prev };
					delete next[id];
					return next;
				});
				// Deleting the Session that's currently routed to leaves the URL
				// pointing at something that no longer exists — drop back to its
				// repo (or home for an orchestrator Session, which has none).
				if (selectedSessionId === id) {
					navigate(
						selectedRepoId ? repoRoute(selectedRepoId, null) : { kind: "home" },
						{ replace: true },
					);
				}
			} catch (e) {
				console.error(e);
			} finally {
				setDeletingSessionIds((prev) => prev.filter((x) => x !== id));
			}
		},
		[
			selectedSessionId,
			selectedRepoId,
			repoRoute,
			navigate,
			deletingSessionIds,
		],
	);

	const handleOpenMetrics = useCallback(() => {
		navigate({ kind: "metrics" });
		mobileSheet.close();
	}, [navigate, mobileSheet.close]);

	const handleOpenSettings = useCallback(() => {
		navigate({ kind: "settings" });
		mobileSheet.close();
	}, [navigate, mobileSheet.close]);

	// The standalone views' own back arrow. These are real routes now, so
	// "back" is literally the browser's back — which lands wherever the user
	// actually came from, instead of guessing at a repo/session to restore.
	// Falls back to home when the view was deep-linked into with no history
	// behind it.
	const handleBackFromStandalone = useCallback(() => {
		if (window.history.length > 1) window.history.back();
		else navigate({ kind: "home" }, { replace: true });
	}, [navigate]);

	const repoSlugById = Object.fromEntries(
		repos.map((r) => [r.id, r.slug] as const),
	);
	const primaryLanguageByRepoId = Object.fromEntries(
		Object.entries(statsByRepoId).map(([id, s]) => [id, s.languages[0]?.name]),
	);
	// Shared by the desktop Sidebar and its mobile-sheet counterpart, which
	// differ only in `variant` and (for the sheet) closing itself before
	// handing off to the New Repo dialog.
	const sidebarProps = {
		repos,
		loadingRepos,
		error: repoError,
		selectedRepoId,
		onSelectRepo: handleSelectRepo,
		onRefreshRepos: pullRepos,
		refreshingRepos: pullingRepos,
		onNewSession: handleNewSession,
		creatingSession,
		selectedSessionId,
		sessionsByRepoId,
		backgroundSessions,
		repoSlugById,
		onSelectSession: handleSelectSession,
		rateLimitWindows,
		primaryLanguageByRepoId,
		syncStatusByRepoId,
		orchestratorSessions,
		onNewOrchestratorSession: handleNewOrchestratorSession,
		creatingOrchestrator,
		onSelectOrchestratorSession: handleSelectOrchestratorSession,
		unreadBySessionId,
		deletingSessionIds,
		notificationsEnabled,
		toggleNotifications,
		// Only meaningful in the sheet variant — see Sidebar's own prop doc.
		currentSession: selectedSession,
		onDeleteCurrentSession: handleDeleteSession,
		onOpenMetrics: handleOpenMetrics,
		onOpenSettings: handleOpenSettings,
	};

	return (
		<>
			<div className="flex h-dvh w-screen pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pl-[env(safe-area-inset-left)]">
				{isDesktop && !sidebarCollapsed && (
					<Sidebar
						{...sidebarProps}
						onNewRepo={() => setNewRepoOpen(true)}
						onCollapse={() => setSidebarCollapsed(true)}
					/>
				)}
				<main className="flex flex-1 flex-col overflow-hidden">
					{/* Metrics and Settings are full pages of their own, rendered in
					    place of the chat column — not over it. The Sidebar beside them
					    stays live, and clicking anything in it routes away from here
					    like any other navigation. */}
					{route.kind === "metrics" ? (
						<MetricsPage repos={repos} onBack={handleBackFromStandalone} />
					) : route.kind === "settings" ? (
						<SettingsPage onBack={handleBackFromStandalone} />
					) : (
						<>
							{selectedRepo ? (
								<ChatHeader
									repo={selectedRepo}
									selectedSession={selectedSession}
									onDeleteSession={handleDeleteSession}
									deletingSession={
										selectedSession !== null &&
										deletingSessionIds.includes(selectedSession.id)
									}
									menuTrigger={mobileSheet.menuTrigger}
									filesTrigger={mobileSheet.filesTrigger}
									sidebarCollapsed={isDesktop && sidebarCollapsed}
									onExpandSidebar={() => setSidebarCollapsed(false)}
									contextCollapsed={isDesktop && contextCollapsed}
									onExpandContext={() => setContextCollapsed(false)}
								/>
							) : (
								<header className="relative z-[60] flex h-14 items-center gap-2 border-b border-border bg-background px-4">
									<MobileMenuButton trigger={mobileSheet.menuTrigger} />
									{isDesktop && sidebarCollapsed && (
										<ExpandSidebarButton
											onClick={() => setSidebarCollapsed(false)}
										/>
									)}
									<span className="text-muted-foreground">dilna</span>
									<AppVersion className="ml-1 max-w-none" />
								</header>
							)}
							{selectedSession ? (
								<div className="flex flex-1 overflow-hidden">
									<div className="flex flex-1 flex-col overflow-hidden">
										<ChatShell
											sessionId={selectedSession.id}
											session={selectedSession}
											isDesktop={isDesktop}
										/>
									</div>
									{selectedRepo && isDesktop && !contextCollapsed && (
										<ContextPanel
											session={selectedSession}
											repo={selectedRepo}
											stats={statsByRepoId[selectedRepo.id]}
											onCollapse={() => setContextCollapsed(true)}
										/>
									)}
								</div>
							) : (
								<div className="flex flex-1 items-center justify-center p-6">
									{selectedRepo ? (
										<RepoEmpty repo={selectedRepo} />
									) : (
										<EmptyState onNewRepo={() => setNewRepoOpen(true)} />
									)}
								</div>
							)}
						</>
					)}
				</main>
			</div>
			<NewRepoDialog
				open={newRepoOpen}
				onOpenChange={setNewRepoOpen}
				onCloned={reloadRepos}
			/>
			<Drawer
				open={mobileSheet.active !== null}
				onOpenChange={(open) => {
					if (!open) mobileSheet.close();
				}}
			>
				<DrawerContent finalFocus={mobileSheet.finalFocusRef}>
					{mobileSheet.active === "menu" && (
						<Sidebar
							{...sidebarProps}
							variant="sheet"
							onNewRepo={() => {
								mobileSheet.close();
								setNewRepoOpen(true);
							}}
						/>
					)}
					{mobileSheet.active === "files" &&
						selectedSession &&
						selectedRepo && (
							<ContextPanel
								variant="sheet"
								session={selectedSession}
								repo={selectedRepo}
								stats={statsByRepoId[selectedRepo.id]}
							/>
						)}
				</DrawerContent>
			</Drawer>
		</>
	);
}

function EmptyState({ onNewRepo }: { onNewRepo: () => void }) {
	return (
		<div className="max-w-sm text-center">
			<span className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl border border-border bg-card shadow-sm">
				<FolderGit2 className="size-6 text-muted-foreground" />
			</span>
			<h1 className="text-3xl font-semibold tracking-tight">dilna</h1>
			<p className="mt-2 text-balance text-sm text-muted-foreground">
				self-hosted workspace for AI coding agents
			</p>
			<p className="mt-1 text-balance text-xs text-muted-foreground">
				Clone a repository to get started.
			</p>
			<button
				type="button"
				onClick={onNewRepo}
				className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-[background-color,scale] hover:bg-primary/90 active:scale-[0.97]"
			>
				Clone a repository
			</button>
		</div>
	);
}

function RepoEmpty({ repo }: { repo: Repo }) {
	return (
		<div className="max-w-sm text-center">
			<p className="text-sm font-medium">{repo.remoteUrl}</p>
			<p className="mt-1 text-xs text-muted-foreground">
				default branch: <span className="font-mono">{repo.defaultBranch}</span>
			</p>
			<p className="mt-4 text-balance text-sm text-muted-foreground">
				Click "New session" in the sidebar to start one, or pick an existing
				session from the dropdown above.
			</p>
		</div>
	);
}
