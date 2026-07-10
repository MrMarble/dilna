import { useMediaQuery } from "@base-ui/react/unstable-use-media-query";
import type {
	RateLimitWindow,
	RepoStats,
	SessionListEvent,
} from "@dilna/shared";
import { FolderGit2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Repo, type SessionView } from "@/api/client";
import { ChatHeader, MobileMenuButton } from "@/components/ChatHeader";
import { ChatShell } from "@/components/ChatShell";
import { ContextPanel } from "@/components/ContextPanel";
import { NewRepoDialog } from "@/components/NewRepoDialog";
import { Sidebar } from "@/components/Sidebar";
import { Drawer, DrawerContent } from "@/components/ui/drawer";
import { useMobileSheet } from "@/hooks/useMobileSheet";

// Tailwind's default `md` breakpoint (no `--breakpoint-md` override in
// index.css), matching the `md:hidden`/`md:flex` classes used throughout —
// see issue #12.
const DESKTOP_QUERY = "(min-width: 768px)";

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
	const [newRepoOpen, setNewRepoOpen] = useState(false);
	const [creatingSession, setCreatingSession] = useState(false);
	const [rateLimitWindows, setRateLimitWindows] = useState<RateLimitWindow[]>(
		[],
	);
	const [statsByRepoId, setStatsByRepoId] = useState<Record<string, RepoStats>>(
		{},
	);
	// Below 768px the desktop Sidebar/ContextPanel aren't rendered at all
	// (rather than just hidden via CSS) so their SSE subscriptions don't run
	// twice alongside the mobile sheet's own instances — see issue #12.
	const isDesktop = useMediaQuery(DESKTOP_QUERY, { noSsr: true });
	const mobileSheet = useMobileSheet();

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

	// Single cross-session status subscription (per ADR-0008) — the source
	// of truth for every session's live state, across every repo. Powers the
	// header's session dropdown and the sidebar's Background Agents panel.
	useEffect(() => {
		const unsubscribe = api.sessionList.stream((ev: SessionListEvent) => {
			if (ev.type === "session_status") {
				setSessionsById((prev) => ({ ...prev, [ev.session.id]: ev.session }));
			} else if (ev.type === "session_deleted") {
				setSessionsById((prev) => {
					if (!(ev.sessionId in prev)) return prev;
					const next = { ...prev };
					delete next[ev.sessionId];
					return next;
				});
			} else if (ev.type === "rate_limits") {
				setRateLimitWindows(ev.windows);
			}
		});
		return unsubscribe;
	}, []);

	const selectedRepo = repos.find((r) => r.id === selectedRepoId) ?? null;
	const selectedSession = selectedSessionId
		? (sessionsById[selectedSessionId] ?? null)
		: null;

	const repoSessions = useMemo(
		() =>
			Object.values(sessionsById)
				.filter((s) => s.repoId === selectedRepoId)
				.sort((a, b) => b.lastActiveAt - a.lastActiveAt),
		[sessionsById, selectedRepoId],
	);

	const backgroundSessions = useMemo(
		() =>
			Object.values(sessionsById)
				.filter((s) => s.id !== selectedSessionId && s.status !== "idle")
				.sort((a, b) => b.lastActiveAt - a.lastActiveAt),
		[sessionsById, selectedSessionId],
	);

	const handleSelectRepo = useCallback(
		(id: string) => {
			setSelectedRepoId(id);
			const latest = Object.values(sessionsById)
				.filter((s) => s.repoId === id)
				.sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
			setSelectedSessionId(latest?.id ?? null);
			mobileSheet.close();
		},
		[sessionsById, mobileSheet.close],
	);

	const handleSelectSession = useCallback(
		(session: SessionView) => {
			setSelectedRepoId(session.repoId);
			setSelectedSessionId(session.id);
			mobileSheet.close();
		},
		[mobileSheet.close],
	);

	const handleSessionCreated = useCallback(
		(session: SessionView) => {
			setSessionsById((prev) => ({ ...prev, [session.id]: session }));
			setSelectedSessionId(session.id);
			mobileSheet.close();
		},
		[mobileSheet.close],
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
				if (selectedSessionId === id) setSelectedSessionId(null);
			} catch (e) {
				console.error(e);
			}
		},
		[selectedSessionId],
	);

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
		backgroundSessions,
		repoSlugById,
		onSelectBackgroundSession: handleSelectSession,
		rateLimitWindows,
		primaryLanguageByRepoId,
		// Only meaningful in the sheet variant — see Sidebar's own prop doc.
		currentSession: selectedSession,
		onDeleteCurrentSession: handleDeleteSession,
	};

	return (
		<>
			<div className="flex h-screen w-screen">
				{isDesktop && (
					<Sidebar {...sidebarProps} onNewRepo={() => setNewRepoOpen(true)} />
				)}
				<main className="flex flex-1 flex-col overflow-hidden">
					{selectedRepo ? (
						<ChatHeader
							repo={selectedRepo}
							sessions={repoSessions}
							selectedSession={selectedSession}
							onSelectSession={handleSelectSession}
							onDeleteSession={handleDeleteSession}
							menuTrigger={mobileSheet.menuTrigger}
							filesTrigger={mobileSheet.filesTrigger}
						/>
					) : (
						<header className="relative z-[60] flex h-14 items-center gap-2 border-b border-border bg-background px-4">
							<MobileMenuButton trigger={mobileSheet.menuTrigger} />
							<span className="text-muted-foreground">dilna</span>
						</header>
					)}
					{selectedSession ? (
						<div className="flex flex-1 overflow-hidden">
							<div className="flex flex-1 flex-col overflow-hidden">
								<ChatShell
									sessionId={selectedSession.id}
									session={selectedSession}
								/>
							</div>
							{selectedRepo && isDesktop && (
								<ContextPanel
									session={selectedSession}
									repo={selectedRepo}
									stats={statsByRepoId[selectedRepo.id]}
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
