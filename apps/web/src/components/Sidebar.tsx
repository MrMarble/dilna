import type { Repo } from "@dilna/shared";
import { ServerIcon } from "lucide-react";

type Props = {
	repos: Repo[];
	loading: boolean;
	error: string | null;
	selectedRepoId: string | null;
	onSelectRepo: (id: string) => void;
	onRefresh: () => void;
	onNewRepo: () => void;
};

export function Sidebar({
	repos,
	loading,
	error,
	selectedRepoId,
	onSelectRepo,
	onRefresh,
	onNewRepo,
}: Props) {
	return (
		<aside className="flex w-64 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950">
			<div className="flex h-14 items-center gap-2 border-b border-zinc-200 px-4 dark:border-zinc-800">
				<ServerIcon className="size-5 text-zinc-500" />
				<span className="font-semibold tracking-tight">dilna</span>
			</div>

			<div className="flex items-center justify-between px-4 py-3">
				<span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					Repositories
				</span>
				<button
					type="button"
					onClick={onNewRepo}
					className="rounded-md px-1.5 text-lg leading-none text-muted-foreground hover:bg-zinc-200 dark:hover:bg-zinc-800"
					title="Clone repository"
				>
					+
				</button>
			</div>

			<div className="flex-1 overflow-y-auto px-2">
				{loading && repos.length === 0 ? (
					<p className="px-2 py-4 text-sm text-muted-foreground">Loading…</p>
				) : error ? (
					<p className="px-2 py-4 text-sm text-red-500">{error}</p>
				) : repos.length === 0 ? (
					<p className="px-2 py-4 text-sm text-muted-foreground">
						No repositories yet. Click + to clone one.
					</p>
				) : (
					<ul className="space-y-0.5">
						{repos.map((repo) => (
							<li key={repo.id}>
								<button
									type="button"
									onClick={() => onSelectRepo(repo.id)}
									className={
										"w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors " +
										(repo.id === selectedRepoId
											? "bg-zinc-200 font-medium dark:bg-zinc-800"
											: "hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50")
									}
								>
									{repo.slug}
								</button>
							</li>
						))}
					</ul>
				)}
			</div>

			<div className="border-t border-zinc-200 p-2 dark:border-zinc-800">
				<button
					type="button"
					onClick={onRefresh}
					className="w-full rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-zinc-200 dark:hover:bg-zinc-800"
				>
					Refresh
				</button>
			</div>
		</aside>
	);
}
