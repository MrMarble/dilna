import type { SessionListEvent } from "@dilna/shared";
import { FolderGit2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Repo, type SessionView } from "@/api/client";
import { ChatHeader } from "@/components/ChatHeader";
import { ChatShell } from "@/components/ChatShell";
import { NewRepoDialog } from "@/components/NewRepoDialog";
import { NewSessionDialog } from "@/components/NewSessionDialog";
import { Sidebar } from "@/components/Sidebar";

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
	const [newSessionOpen, setNewSessionOpen] = useState(false);

	const refreshRepos = useCallback(async () => {
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

	useEffect(() => {
		refreshRepos();
	}, [refreshRepos]);

	// Cmd/Ctrl+K opens New Session for the currently selected repo, mirroring
	// the sidebar button's shortcut hint. No-op with no repo selected, same
	// as the button's disabled state.
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
				e.preventDefault();
				if (selectedRepoId) setNewSessionOpen(true);
			}
		}
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [selectedRepoId]);

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
		},
		[sessionsById],
	);

	const handleSelectSession = useCallback((session: SessionView) => {
		setSelectedRepoId(session.repoId);
		setSelectedSessionId(session.id);
	}, []);

	const handleSessionCreated = useCallback((session: SessionView) => {
		setSessionsById((prev) => ({ ...prev, [session.id]: session }));
		setSelectedSessionId(session.id);
	}, []);

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

	return (
		<>
			<div className="flex h-screen w-screen">
				<Sidebar
					repos={repos}
					loadingRepos={loadingRepos}
					error={repoError}
					selectedRepoId={selectedRepoId}
					onSelectRepo={handleSelectRepo}
					onRefreshRepos={refreshRepos}
					onNewRepo={() => setNewRepoOpen(true)}
					onNewSession={() => setNewSessionOpen(true)}
					backgroundSessions={backgroundSessions}
					repoSlugById={Object.fromEntries(
						repos.map((r) => [r.id, r.slug] as const),
					)}
					onSelectBackgroundSession={handleSelectSession}
				/>
				<main className="flex flex-1 flex-col overflow-hidden">
					{selectedRepo ? (
						<ChatHeader
							repo={selectedRepo}
							sessions={repoSessions}
							selectedSession={selectedSession}
							onSelectSession={handleSelectSession}
							onDeleteSession={handleDeleteSession}
						/>
					) : (
						<header className="flex h-14 items-center gap-2 border-b border-zinc-200 px-4 dark:border-zinc-800">
							<span className="text-muted-foreground">dilna</span>
						</header>
					)}
					{selectedSession ? (
						<ChatShell
							sessionId={selectedSession.id}
							session={selectedSession}
						/>
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
				onCloned={refreshRepos}
			/>
			{selectedRepoId && (
				<NewSessionDialog
					open={newSessionOpen}
					onOpenChange={setNewSessionOpen}
					repoId={selectedRepoId}
					onCreated={handleSessionCreated}
				/>
			)}
		</>
	);
}

function EmptyState() {
	return (
		<div className="text-center">
			<FolderGit2 className="mx-auto mb-3 size-10 text-muted-foreground" />
			<h1 className="text-2xl font-semibold tracking-tight">dilna</h1>
			<p className="mt-2 text-sm text-muted-foreground">
				self-hosted workspace for AI coding agents
			</p>
			<p className="mt-1 text-xs text-muted-foreground">
				Clone a repository from the sidebar to get started.
			</p>
		</div>
	);
}

function RepoEmpty({ repo }: { repo: Repo }) {
	return (
		<div className="text-center">
			<p className="text-sm font-medium">{repo.remoteUrl}</p>
			<p className="mt-1 text-xs text-muted-foreground">
				default branch: {repo.defaultBranch}
			</p>
			<p className="mt-4 text-sm text-muted-foreground">
				Click "New session" in the sidebar to start one, or pick an existing
				session from the dropdown above.
			</p>
		</div>
	);
}
