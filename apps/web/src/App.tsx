import { FolderGit2, MessageSquare } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type Repo, type SessionView } from "@/api/client";
import { ChatShell } from "@/components/ChatShell";
import { NewRepoDialog } from "@/components/NewRepoDialog";
import { Sidebar } from "@/components/Sidebar";

export function App() {
	const [repos, setRepos] = useState<Repo[]>([]);
	const [sessions, setSessions] = useState<SessionView[]>([]);
	const [loadingRepos, setLoadingRepos] = useState(true);
	const [loadingSessions, setLoadingSessions] = useState(false);
	const [repoError, setRepoError] = useState<string | null>(null);
	const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
	const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
		null,
	);
	const [newRepoOpen, setNewRepoOpen] = useState(false);

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

	const refreshSessions = useCallback(async (repoId: string) => {
		setLoadingSessions(true);
		try {
			const { sessions } = await api.sessions.listByRepo(repoId);
			setSessions(sessions);
		} catch {
			setSessions([]);
		} finally {
			setLoadingSessions(false);
		}
	}, []);

	useEffect(() => {
		refreshRepos();
	}, [refreshRepos]);

	useEffect(() => {
		setSelectedSessionId(null);
		setSessions([]);
		if (selectedRepoId) refreshSessions(selectedRepoId);
	}, [selectedRepoId, refreshSessions]);

	const selectedRepo = repos.find((r) => r.id === selectedRepoId) ?? null;
	const selectedSession =
		sessions.find((s) => s.id === selectedSessionId) ?? null;

	const handleNewSession = useCallback(async () => {
		if (!selectedRepoId) return;
		try {
			const { session } = await api.sessions.create(selectedRepoId);
			setSessions((prev) => [session, ...prev]);
			setSelectedSessionId(session.id);
		} catch (e) {
			console.error(e);
		}
	}, [selectedRepoId]);

	const handleDeleteSession = useCallback(async (id: string) => {
		try {
			await api.sessions.delete(id);
			setSessions((prev) => prev.filter((s) => s.id !== id));
			setSelectedSessionId((prev) => (prev === id ? null : prev));
		} catch (e) {
			console.error(e);
		}
	}, []);

	return (
		<>
			<div className="flex h-screen w-screen">
				<Sidebar
					repos={repos}
					sessions={sessions}
					loadingRepos={loadingRepos}
					loadingSessions={loadingSessions}
					error={repoError}
					selectedRepoId={selectedRepoId}
					selectedSessionId={selectedSessionId}
					onSelectRepo={setSelectedRepoId}
					onSelectSession={setSelectedSessionId}
					onRefreshRepos={refreshRepos}
					onNewRepo={() => setNewRepoOpen(true)}
					onNewSession={handleNewSession}
					onDeleteSession={handleDeleteSession}
				/>
				<main className="flex flex-1 flex-col overflow-hidden">
					<header className="flex h-14 items-center gap-2 border-b border-zinc-200 px-4 dark:border-zinc-800">
						{selectedSession ? (
							<>
								<MessageSquare className="size-4 text-muted-foreground" />
								<span className="font-medium">{selectedSession.title}</span>
							</>
						) : selectedRepo ? (
							<>
								<FolderGit2 className="size-4 text-muted-foreground" />
								<span className="font-medium">{selectedRepo.slug}</span>
							</>
						) : (
							<span className="text-muted-foreground">dilna</span>
						)}
					</header>
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
				Click + on Sessions to start a new session for this repo.
			</p>
		</div>
	);
}
