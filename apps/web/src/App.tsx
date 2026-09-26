import { FolderGit2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
	api,
	type ComparisonView as ComparisonData,
	type Repo,
	type SessionView,
} from "@/api/client";
import { AppVersion } from "@/components/AppVersion";
import {
	ChatHeader,
	ExpandSidebarButton,
	MobileMenuButton,
} from "@/components/ChatHeader";
import { ChatShell } from "@/components/ChatShell";
import { ComparisonView } from "@/components/ComparisonView";
import { ConfirmDeleteSessionDialog } from "@/components/ConfirmDeleteSessionDialog";
import { ContextPanel } from "@/components/ContextPanel";
import { MetricsPage } from "@/components/MetricsPage";
import { NewComparisonDialog } from "@/components/NewComparisonDialog";
import { NewRepoDialog } from "@/components/NewRepoDialog";
import { SettingsPage } from "@/components/SettingsPage";
import { Sidebar } from "@/components/Sidebar";
import { SkillsPage } from "@/components/SkillsPage";
import { Drawer, DrawerContent } from "@/components/ui/drawer";
import { useIsDesktop } from "@/hooks/useIsDesktop";
import { useMobileSheet } from "@/hooks/useMobileSheet";
import { usePersistedBoolean } from "@/hooks/usePersistedBoolean";
import { useRepoList } from "@/hooks/useRepoList";
import { useRoute } from "@/hooks/useRoute";
import { clearSessionDraft } from "@/hooks/useSessionDraft";
import { useSessionList } from "@/hooks/useSessionList";
import { useSessionNotifications } from "@/hooks/useSessionNotifications";
import { isReservedSlug, type Route } from "@/lib/routes";

export function App() {
	// Repos plus their stats, sync badges and the pull operation (issue #174).
	const {
		repos,
		loading: loadingRepos,
		pulling: pullingRepos,
		error: repoError,
		statsByRepoId,
		syncStatusByRepoId,
		reload: reloadRepos,
		pull: pullRepos,
	} = useRepoList();
	// The URL is the single source of truth for which view is showing and what
	// it's showing (see lib/routes.ts). Everything below derives from `route`
	// rather than tracking its own copy, which is what keeps deep links, back/
	// forward and refresh consistent for free — and what stops Metrics/Settings
	// from behaving like overlays that the sidebar can't navigate out of.
	const { route, navigate, requestedSessionId, clearRequestedSession } =
		useRoute();

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

	const [newRepoOpen, setNewRepoOpen] = useState(false);
	const [newComparisonOpen, setNewComparisonOpen] = useState(false);
	const [creatingSession, setCreatingSession] = useState(false);
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
		pushSupported,
		pushSubscribed,
	} = useSessionNotifications({ selectedSessionId });
	// Every Session's live state, from the single cross-Session SSE stream
	// (ADR-0008, issue #174). `handleSessionStatus`/`forgetSession` feed the
	// unread badges (issue #52) off the same transitions; both are
	// referentially stable, which is what lets the stream stay open across
	// re-renders.
	const {
		sessionsById,
		rateLimitWindows,
		sessionsByRepoId,
		backgroundSessions,
		orchestratorSessions,
		upsert: upsertSession,
		remove: removeSession,
	} = useSessionList({
		selectedSessionId,
		onSessionStatus: handleSessionStatus,
		onSessionForgotten: forgetSession,
	});
	const selectedSession = selectedSessionId
		? (sessionsById[selectedSessionId] ?? null)
		: null;
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

	// A push notification's tap target is `/?session=<id>` (see the service
	// worker's `notificationclick`): the notification is raised when no tab is
	// open, so it can't name a path that depends on state the page hasn't
	// loaded yet. `useRoute` reports the requested id; this resolves it to a
	// real route once the cross-session stream has told us which repo that
	// Session belongs to. Before this existed the query string was written by
	// `sw.js` and read by nothing — the deep link had never worked.
	useEffect(() => {
		if (!requestedSessionId) return;
		const session = sessionsById[requestedSessionId];
		// Not yet known: the stream may simply not have delivered it. Leave the
		// request in place rather than bouncing the user to home.
		if (!session) return;
		if (session.kind === "orchestrator") {
			navigate(
				{ kind: "orchestrator", sessionId: session.id },
				{ replace: true },
			);
			clearRequestedSession();
			return;
		}
		// A repo-bound Session needs its Repo resolved before it can be
		// addressed as `/<slug>/<id>`. The session list and the repo list load
		// independently, so this effect runs again when the repo arrives — and
		// must not give up (nor fall back to home) while `repos` is still empty.
		if (!repos.some((r) => r.id === session.repoId)) return;
		navigate(repoRoute(session.repoId, session.id), { replace: true });
		clearRequestedSession();
	}, [
		requestedSessionId,
		sessionsById,
		repos,
		navigate,
		repoRoute,
		clearRequestedSession,
	]);

	// Clicking a repo in the sidebar selects it and expands its Session list —
	// it deliberately does *not* open any Session, and (on mobile) deliberately
	// leaves the sheet open. Auto-jumping to the most recently active Session
	// meant the sheet closed on the same tap that expanded the repo, so a user
	// with several Sessions had to reopen the drawer and hunt for the one they
	// actually wanted. Picking a Session is now the only thing that commits to
	// one, and it's the only thing that dismisses the drawer.
	const handleSelectRepo = useCallback(
		(id: string) => {
			navigate(repoRoute(id, null));
		},
		[repoRoute, navigate],
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
			upsertSession(session);
			navigate(repoRoute(session.repoId, session.id));
			mobileSheet.close();
		},
		[upsertSession, repoRoute, navigate, mobileSheet.close],
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
	// The Session whose trash icon was clicked, awaiting confirmation. Every
	// delete affordance goes through this rather than straight to
	// handleDeleteSession — see ConfirmDeleteSessionDialog.
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

	const [creatingOrchestrator, setCreatingOrchestrator] = useState(false);
	const handleNewOrchestratorSession = useCallback(async () => {
		if (creatingOrchestrator) return;
		setCreatingOrchestrator(true);
		try {
			const { session } = await api.sessions.createOrchestrator();
			upsertSession(session);
			navigate({ kind: "orchestrator", sessionId: session.id });
			mobileSheet.close();
		} catch (e) {
			console.error(e);
		} finally {
			setCreatingOrchestrator(false);
		}
	}, [creatingOrchestrator, upsertSession, navigate, mobileSheet.close]);

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
				// The Session is gone, so its persisted composer draft is garbage —
				// without this, drafts for deleted Sessions pile up in localStorage.
				clearSessionDraft(id);
				removeSession(id);
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
			removeSession,
			deletingSessionIds,
		],
	);

	const handleOpenMetrics = useCallback(() => {
		navigate({ kind: "metrics" });
		mobileSheet.close();
	}, [navigate, mobileSheet.close]);

	// Issue #250: the comparison modal resolved — put the arms into the
	// session map (so the sidebar shows them without waiting for their
	// broadcasts to round-trip), refresh the repo list (the modal may have
	// minted a workspace), and land on the comparison view.
	const handleComparisonCreated = useCallback(
		(comparison: ComparisonData) => {
			for (const session of comparison.sessions) upsertSession(session);
			void reloadRepos();
			navigate({ kind: "comparison", groupId: comparison.id });
			mobileSheet.close();
		},
		[upsertSession, reloadRepos, navigate, mobileSheet.close],
	);

	// Asks before deleting (see confirmDeleteId). The mobile sheet closes
	// first so the dialog isn't stacked on top of it.
	const handleRequestDeleteSession = useCallback(
		(id: string) => {
			mobileSheet.close();
			setConfirmDeleteId(id);
		},
		[mobileSheet.close],
	);

	// An arm opened as a plain Session (ADR-0047) links back to its
	// comparison view from the chat header.
	const handleOpenComparison = useCallback(
		(groupId: string) => {
			navigate({ kind: "comparison", groupId });
			mobileSheet.close();
		},
		[navigate, mobileSheet.close],
	);

	const handleOpenSettings = useCallback(() => {
		navigate({ kind: "settings" });
		mobileSheet.close();
	}, [navigate, mobileSheet.close]);

	const handleOpenSkills = useCallback(() => {
		navigate({ kind: "skills" });
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
		onNewComparison: () => {
			mobileSheet.close();
			setNewComparisonOpen(true);
		},
		orchestratorSessions,
		onNewOrchestratorSession: handleNewOrchestratorSession,
		creatingOrchestrator,
		onSelectOrchestratorSession: handleSelectOrchestratorSession,
		unreadBySessionId,
		deletingSessionIds,
		notificationsEnabled,
		toggleNotifications,
		pushSupported,
		pushSubscribed,
		// Only meaningful in the sheet variant — see Sidebar's own prop doc.
		currentSession: selectedSession,
		onDeleteCurrentSession: handleRequestDeleteSession,
		onOpenMetrics: handleOpenMetrics,
		onOpenSettings: handleOpenSettings,
		onOpenSkills: handleOpenSkills,
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
					) : route.kind === "skills" ? (
						<SkillsPage repos={repos} onBack={handleBackFromStandalone} />
					) : route.kind === "comparison" ? (
						<ComparisonView
							groupId={route.groupId}
							repos={repos}
							isDesktop={isDesktop}
							onBack={handleBackFromStandalone}
						/>
					) : (
						<>
							{selectedRepo ? (
								<ChatHeader
									repo={selectedRepo}
									selectedSession={selectedSession}
									onDeleteSession={handleRequestDeleteSession}
									onOpenComparison={handleOpenComparison}
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
			<ConfirmDeleteSessionDialog
				session={
					confirmDeleteId ? (sessionsById[confirmDeleteId] ?? null) : null
				}
				onCancel={() => setConfirmDeleteId(null)}
				onConfirm={(id) => {
					setConfirmDeleteId(null);
					void handleDeleteSession(id);
				}}
			/>
			<NewComparisonDialog
				open={newComparisonOpen}
				onOpenChange={setNewComparisonOpen}
				repos={repos}
				onCreated={handleComparisonCreated}
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
			<p className="text-sm font-medium">
				{repo.remoteUrl || "Local workspace (no remote)"}
			</p>
			<p className="mt-1 text-xs text-muted-foreground">
				default branch: <span className="font-mono">{repo.defaultBranch}</span>
			</p>
			<p className="mt-4 text-balance text-sm text-muted-foreground">
				Click "New session" in the sidebar to start one, or pick an existing
				session from its list.
			</p>
		</div>
	);
}
