import { ServerIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type Repo } from "@/api/client";
import { NewRepoDialog } from "@/components/NewRepoDialog";
import { Sidebar } from "@/components/Sidebar";

export function App() {
	const [repos, setRepos] = useState<Repo[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
	const [newRepoOpen, setNewRepoOpen] = useState(false);

	const refresh = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const { repos } = await api.repos.list();
			setRepos(repos);
		} catch (e) {
			setError(e instanceof Error ? e.message : "failed to load repos");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const selectedRepo = repos.find((r) => r.id === selectedRepoId) ?? null;

	return (
		<>
			<div className="flex h-screen w-screen">
				<Sidebar
					repos={repos}
					loading={loading}
					error={error}
					selectedRepoId={selectedRepoId}
					onSelectRepo={setSelectedRepoId}
					onRefresh={refresh}
					onNewRepo={() => setNewRepoOpen(true)}
				/>
				<main className="flex flex-1 flex-col overflow-hidden">
					<header className="flex h-14 items-center gap-2 border-b border-zinc-200 px-4 dark:border-zinc-800">
						{selectedRepo ? (
							<span className="font-medium">{selectedRepo.slug}</span>
						) : (
							<span className="text-muted-foreground">dilna</span>
						)}
					</header>
					<div className="flex flex-1 items-center justify-center p-6">
						{selectedRepo ? (
							<RepoPlaceholder repo={selectedRepo} />
						) : (
							<EmptyState />
						)}
					</div>
				</main>
			</div>
			<NewRepoDialog
				open={newRepoOpen}
				onOpenChange={setNewRepoOpen}
				onCloned={refresh}
			/>
		</>
	);
}

function EmptyState() {
	return (
		<div className="text-center">
			<ServerIcon className="mx-auto mb-3 size-10 text-muted-foreground" />
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

function RepoPlaceholder({ repo }: { repo: Repo }) {
	return (
		<div className="text-center text-sm">
			<p className="font-medium">{repo.remoteUrl}</p>
			<p className="mt-1 text-muted-foreground">
				default branch: {repo.defaultBranch}
			</p>
			<p className="mt-1 text-muted-foreground">sessions list goes here</p>
		</div>
	);
}
