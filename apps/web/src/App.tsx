import type {
	RateLimitWindow,
	RepoStats,
	RepoSyncStatus,
	SessionListEvent,
} from "@dilna/shared";
import { FolderGit2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { useSessionNotifications } from "@/hooks/useSessionNotifications";

// Keeps the URL shareable/bookmarkable as /<repo-slug>/<session-id> — see
// the App component's history hydration/popstate effects for the read side.
function pushSessionPath(repoSlug: string, sessionId: string | null) {
	const path = sessionId ? `/${repoSlug}/${sessionId}` : `/${repoSlug}`;
	if (path !== window.location.pathname) {
		window.history.pushState(null, "", path);
	}
}

// The metrics dashboard (MetricsPage) — a standalone view, not scoped to
// any repo/session, so it gets its own top-level path rather than nesting
// under pushSessionPath's /<repo-slug> shape.
function pushMetricsPath() {
	if (window.location.pathname !== "/metrics") {
		window.history.pushState(null, "", "/metrics");
	}
}

// The LLM provider/model Settings view — same standalone-view treatment as
// Metrics (above): top-level /settings path, orthogonal to repo/session.
function pushSettingsPath() {
	if (window.location.pathname !== "/settings") {
		window.history.pushState(null, "", "/settings");
	}
}

export function App() {
	const [repos, setRepos] = useState<Repo[]>([]);
	const [sessionsById, setSessionsById] = useState<Record<string, SessionView>>(
		{},
	);
	const [loadingRepos, setLoadingRepos] = useState(true);
	const [repoError, setRepoError] = useState<string | null>(null);
	const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
		null,
	);
	// "metrics" replaces the chat area with the Metrics dashboard
	// (MetricsPage) and "settings" with the provider/model Settings view —
	// both orthogonal to which repo/session is selected, which stays put
	// underneath so "back" restores it.
	const [view, setView] = useState<"chat" | "metrics" | "settings">(
		window.location.pathname === "/metrics"
			? "metrics"
			: window.location.pathname === "/settings"
				? "settings"
				: "chat",
	);
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
	const pullRepos = useCallback(async () => {
		setLoadingRepos(true);
		setRepoError(null);
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
		} finally {
			setLoadingRepos(false);
		}
	}, [repos]);

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

	// Read the initial /<repo-slug>/<session-id> from the URL once repos are
	// available to resolve the slug. Runs once; an unknown slug normalizes
	// the URL back to "/" rather than leaving a dead link in the bar.
	const hydratedFromUrl = useRef(false);
	useEffect(() => {
		if (hydratedFromUrl.current || loadingRepos) return;
		hydratedFromUrl.current = true;
		if (
			window.location.pathname === "/metrics" ||
			window.location.pathname === "/settings"
		)
			return;
		const [repoSlug, sessionId] = window.location.pathname
			.split("/")
			.filter(Boolean);
		if (!repoSlug) return;
		const repo = repos.find((r) => r.slug === repoSlug);
		if (!repo) {
			window.history.replaceState(null, "", "/");
			return;
		}
		setSelectedRepoId(repo.id);
		if (sessionId) setSelectedSessionId(sessionId);
	}, [repos, loadingRepos]);

	// Browser back/forward — the URL has already changed by the time this
	// fires, so just re-derive selection from it.
	useEffect(() => {
		function onPopState() {
			if (window.location.pathname === "/metrics") {
				setView("metrics");
				return;
			}
			if (window.location.pathname === "/settings") {
				setView("settings");
				return;
			}
			setView("chat");
			const [repoSlug, sessionId] = window.location.pathname
				.split("/")
				.filter(Boolean);
			const repo = repoSlug ? repos.find((r) => r.slug === repoSlug) : null;
			setSelectedRepoId(repo?.id ?? null);
			setSelectedSessionId(repo && sessionId ? sessionId : null);
		}
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, [repos]);

	const selectedRepo = repos.find((r) => r.id === selectedRepoId) ?? null;
	const selectedSession = selectedSessionId
		? (sessionsById[selectedSessionId] ?? null)
		: null;

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

	const handleSelectRepo = useCallback(
		(id: string) => {
			setSelectedRepoId(id);
			const latest = Object.values(sessionsById)
				.filter((s) => s.repoId === id)
				.sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
			setSelectedSessionId(latest?.id ?? null);
			// Selecting a repo jumps to its latest session — treat that as
			// reading its unread badge (issue #52).
			if (latest) markRead(latest.id);
			const repo = repos.find((r) => r.id === id);
			if (repo) pushSessionPath(repo.slug, latest?.id ?? null);
			// Only close the mobile sheet when the repo has a session to land
			// on — otherwise closing dumps the user on an empty state with no
			// visible "New session" affordance, forcing them to reopen the
			// sheet just to tap the button that's already right here.
			if (latest) mobileSheet.close();
		},
		[sessionsById, repos, mobileSheet.close, markRead],
	);

	const handleSelectSession = useCallback(
		(session: SessionView) => {
			setSelectedRepoId(session.repoId);
			setSelectedSessionId(session.id);
			// Reading the session clears its completed-turn badge (issue #52).
			markRead(session.id);
			const repo = repos.find((r) => r.id === session.repoId);
			if (repo) pushSessionPath(repo.slug, session.id);
			mobileSheet.close();
		},
		[repos, mobileSheet.close, markRead],
	);

	// Same as handleSelectSession, but never sets selectedRepoId to the
	// orchestrator's meta-repo id — that repo is intentionally excluded from
	// `repos` (ADR-0021), so ChatHeader/ContextPanel (both gated on
	// `selectedRepo`) fall back to their no-repo-selected rendering for free.
	const handleSelectOrchestratorSession = useCallback(
		(session: SessionView) => {
			setSelectedRepoId(null);
			setSelectedSessionId(session.id);
			markRead(session.id);
			mobileSheet.close();
		},
		[mobileSheet.close, markRead],
	);

	const handleSessionCreated = useCallback(
		(session: SessionView) => {
			setSessionsById((prev) => ({ ...prev, [session.id]: session }));
			setSelectedSessionId(session.id);
			const repo = repos.find((r) => r.id === session.repoId);
			if (repo) pushSessionPath(repo.slug, session.id);
			mobileSheet.close();
		},
		[repos, mobileSheet.close],
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

	const [creatingOrchestrator, setCreatingOrchestrator] = useState(false);
	const handleNewOrchestratorSession = useCallback(async () => {
		if (creatingOrchestrator) return;
		setCreatingOrchestrator(true);
		try {
			const { session } = await api.sessions.createOrchestrator();
			setSessionsById((prev) => ({ ...prev, [session.id]: session }));
			setSelectedRepoId(null);
			setSelectedSessionId(session.id);
			mobileSheet.close();
		} catch (e) {
			console.error(e);
		} finally {
			setCreatingOrchestrator(false);
		}
	}, [creatingOrchestrator, mobileSheet.close]);

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

	const handleDeleteSession = useCallback(
		async (id: string) => {
			try {
				await api.sessions.delete(id);
				setSessionsById((prev) => {
					if (!(id in prev)) return prev;
					const next = { ...prev };
					delete next[id];
					return next;
				});
				if (selectedSessionId === id) {
					setSelectedSessionId(null);
					const repo = repos.find((r) => r.id === selectedRepoId);
					if (repo) pushSessionPath(repo.slug, null);
				}
			} catch (e) {
				console.error(e);
			}
		},
		[selectedSessionId, selectedRepoId, repos],
	);

	const handleOpenMetrics = useCallback(() => {
		setView("metrics");
		pushMetricsPath();
		mobileSheet.close();
	}, [mobileSheet.close]);

	const handleOpenSettings = useCallback(() => {
		setView("settings");
		pushSettingsPath();
		mobileSheet.close();
	}, [mobileSheet.close]);

	// Restores whatever repo/session path was showing before the standalone
	// Metrics/Settings views were opened (or "/" if none was selected) — the
	// selection itself was never cleared, just visually replaced.
	const handleBackFromStandalone = useCallback(() => {
		setView("chat");
		const repo = repos.find((r) => r.id === selectedRepoId);
		if (repo) pushSessionPath(repo.slug, selectedSessionId);
		else if (window.location.pathname !== "/") {
			window.history.pushState(null, "", "/");
		}
	}, [repos, selectedRepoId, selectedSessionId]);

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
			<div className="flex h-dvh w-screen">
				{isDesktop && !sidebarCollapsed && (
					<Sidebar
						{...sidebarProps}
						onNewRepo={() => setNewRepoOpen(true)}
						onCollapse={() => setSidebarCollapsed(true)}
					/>
				)}
				<main className="flex flex-1 flex-col overflow-hidden">
					{view === "metrics" ? (
						<MetricsPage repos={repos} onBack={handleBackFromStandalone} />
					) : view === "settings" ? (
						<SettingsPage onBack={handleBackFromStandalone} />
					) : selectedRepo ? (
						<ChatHeader
							repo={selectedRepo}
							selectedSession={selectedSession}
							onDeleteSession={handleDeleteSession}
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
					{view === "metrics" ||
					view === "settings" ? null : selectedSession ? (
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
								<EmptyState />
							)}
						</div>
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

function EmptyState() {
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
				Clone a repository from the sidebar to get started.
			</p>
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
