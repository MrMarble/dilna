import type { Repo, SessionView } from "@dilna/shared";
import { FolderGit2, Plus, RefreshCw, Trash2 } from "lucide-react";

type Props = {
	repos: Repo[];
	sessions: SessionView[];
	loadingRepos: boolean;
	loadingSessions: boolean;
	error: string | null;
	selectedRepoId: string | null;
	selectedSessionId: string | null;
	onSelectRepo: (id: string) => void;
	onSelectSession: (id: string) => void;
	onRefreshRepos: () => void;
	onNewRepo: () => void;
	onNewSession: () => void;
	onDeleteSession: (id: string) => Promise<void>;
};

export function Sidebar({
	repos,
	sessions,
	loadingRepos,
	loadingSessions,
	error,
	selectedRepoId,
	selectedSessionId,
	onSelectRepo,
	onSelectSession,
	onRefreshRepos,
	onNewRepo,
	onNewSession,
	onDeleteSession,
}: Props) {
	return (
		<aside className="flex w-64 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950">
			<div className="flex h-14 items-center gap-2 border-b border-zinc-200 px-4 dark:border-zinc-800">
				<FolderGit2 className="size-5 text-zinc-500" />
				<span className="font-semibold tracking-tight">dilna</span>
			</div>

			<ReposSection
				repos={repos}
				loading={loadingRepos}
				error={error}
				selectedRepoId={selectedRepoId}
				onSelectRepo={onSelectRepo}
				onRefresh={onRefreshRepos}
				onNew={onNewRepo}
			/>

			{selectedRepoId && (
				<SessionsSection
					sessions={sessions}
					loading={loadingSessions}
					selectedSessionId={selectedSessionId}
					onSelectSession={onSelectSession}
					onNew={onNewSession}
					onDelete={onDeleteSession}
				/>
			)}
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
}: {
	repos: Repo[];
	loading: boolean;
	error: string | null;
	selectedRepoId: string | null;
	onSelectRepo: (id: string) => void;
	onRefresh: () => void;
	onNew: () => void;
}) {
	return (
		<div className="flex flex-col border-b border-zinc-200 dark:border-zinc-800">
			<SidebarSectionHeader
				title="Repositories"
				onNew={onNew}
				onRefresh={onRefresh}
			/>
			<div className="max-h-64 overflow-y-auto px-2 pb-2">
				{loading && repos.length === 0 ? (
					<p className="px-2 py-2 text-sm text-muted-foreground">Loading…</p>
				) : error ? (
					<p className="px-2 py-2 text-sm text-red-500">{error}</p>
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
		</div>
	);
}

function SessionsSection({
	sessions,
	loading,
	selectedSessionId,
	onSelectSession,
	onNew,
	onDelete,
}: {
	sessions: SessionView[];
	loading: boolean;
	selectedSessionId: string | null;
	onSelectSession: (id: string) => void;
	onNew: () => void;
	onDelete: (id: string) => Promise<void>;
}) {
	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			<SidebarSectionHeader title="Sessions" onNew={onNew} />
			<div className="flex-1 overflow-y-auto px-2 pb-2">
				{loading && sessions.length === 0 ? (
					<p className="px-2 py-2 text-sm text-muted-foreground">Loading…</p>
				) : sessions.length === 0 ? (
					<p className="px-2 py-2 text-sm text-muted-foreground">
						No sessions. Click + to start one.
					</p>
				) : (
					<ul className="space-y-0.5">
						{sessions.map((session) => (
							<li key={session.id}>
								<SessionRow
									session={session}
									selected={session.id === selectedSessionId}
									onSelect={() => onSelectSession(session.id)}
									onDelete={() => onDelete(session.id)}
								/>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	);
}

function SessionRow({
	session,
	selected,
	onSelect,
	onDelete,
}: {
	session: SessionView;
	selected: boolean;
	onSelect: () => void;
	onDelete: () => void;
}) {
	return (
		<div
			className={
				"group flex items-center gap-1 rounded-md px-2 py-1.5 text-sm transition-colors " +
				(selected
					? "bg-zinc-200 dark:bg-zinc-800"
					: "hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50")
			}
		>
			<button
				type="button"
				onClick={onSelect}
				className="flex flex-1 items-center gap-1.5 overflow-hidden text-left"
			>
				<StatusDot status={session.status} />
				<span className={selected ? "font-medium" : ""}>{session.title}</span>
			</button>
			<button
				type="button"
				onClick={(e) => {
					e.stopPropagation();
					onDelete();
				}}
				className="shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-zinc-300 hover:text-red-500 group-hover:opacity-100 dark:hover:bg-zinc-700"
				title="Delete session"
			>
				<Trash2 className="size-3.5" />
			</button>
		</div>
	);
}

function StatusDot({ status }: { status: SessionView["status"] }) {
	const color =
		status === "working"
			? "bg-emerald-500"
			: status === "starting" || status === "stopping"
				? "bg-amber-500"
				: status === "crashed"
					? "bg-red-500"
					: "bg-zinc-400";
	return <span className={`size-1.5 shrink-0 rounded-full ${color}`} />;
}

function SidebarSectionHeader({
	title,
	onNew,
	onRefresh,
}: {
	title: string;
	onNew: () => void;
	onRefresh?: () => void;
}) {
	return (
		<div className="flex items-center justify-between px-4 py-2">
			<span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
				{title}
			</span>
			<div className="flex items-center gap-0.5">
				{onRefresh && (
					<button
						type="button"
						onClick={onRefresh}
						className="rounded-md p-1 text-muted-foreground hover:bg-zinc-200 dark:hover:bg-zinc-800"
						title="Refresh"
					>
						<RefreshCw className="size-3.5" />
					</button>
				)}
				<button
					type="button"
					onClick={onNew}
					className="rounded-md p-1 text-muted-foreground hover:bg-zinc-200 dark:hover:bg-zinc-800"
					title={`New ${title.slice(0, -1)}`}
				>
					<Plus className="size-3.5" />
				</button>
			</div>
		</div>
	);
}
