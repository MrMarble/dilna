import type {
	ChangedFile,
	CommitInfo,
	Repo,
	RepoStats,
	SessionView,
} from "@dilna/shared";
import {
	FileDiff,
	FilePlus,
	FileX,
	GitCommitHorizontal,
	Pencil,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/api/client";
import { LanguageIcon, languageColor } from "@/lib/languages";

type Props = {
	session: SessionView;
	repo: Repo;
	/** Fetched by App alongside the sidebar's language icons; undefined while
	 * loading or if the stats request failed — the section degrades to just
	 * the branch row. */
	stats: RepoStats | undefined;
};

function formatDateTime(epochSeconds: number) {
	return new Date(epochSeconds * 1000).toLocaleString([], {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}

function timeAgo(epochSeconds: number) {
	const s = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
	if (s < 60) return "just now";
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Right-hand context panel (per the ui_draft mock): repo facts, current
 * session facts, changed files, and recent commits. Changed files stay live
 * via the session's SSE stream; recent commits are refetched off the same
 * `changed_files` event, since both only change at end of turn (see
 * SessionManager.sendMessage).
 */
export function ContextPanel({ session, repo, stats }: Props) {
	const [files, setFiles] = useState<ChangedFile[]>([]);
	const [commits, setCommits] = useState<CommitInfo[]>([]);
	const [error, setError] = useState<string | null>(null);

	const loadCommits = useCallback(() => {
		api.sessions
			.commits(session.id)
			.then(({ commits }) => setCommits(commits))
			.catch(() => setCommits([]));
	}, [session.id]);

	useEffect(() => {
		let cancelled = false;
		setFiles([]);
		setError(null);

		// Initial snapshot so the panel has content immediately (e.g. resuming
		// a session with prior turns), before any live event arrives.
		api.sessions
			.changedFiles(session.id)
			.then(({ files }) => {
				if (!cancelled) setFiles(files);
			})
			.catch((e) => {
				if (!cancelled) {
					setError(e instanceof Error ? e.message : "failed to load changes");
				}
			});
		loadCommits();

		// Own SSE subscription (independent of ChatShell's) kept live for the
		// lifetime of the panel; recomputed files arrive after every turn.
		const unsubscribe = api.sessions.stream(session.id, (ev) => {
			if (ev.type === "changed_files") {
				setFiles(ev.files);
				loadCommits();
			}
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [session.id, loadCommits]);

	return (
		<aside className="flex w-80 shrink-0 flex-col border-l border-sidebar-border bg-sidebar">
			<div className="flex h-14 shrink-0 items-center border-b border-sidebar-border px-4">
				<span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					Context
				</span>
			</div>
			<div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
				<RepositorySection repo={repo} stats={stats} />
				<SessionSection session={session} />
				<ChangedFilesSection files={files} error={error} />
				<CommitsSection commits={commits} />
			</div>
		</aside>
	);
}

/** Floating card, matching the draft mock (and the sidebar's Background
 * Agents card) rather than full-width bordered sections. */
function SectionCard({
	title,
	badge,
	children,
}: {
	title: string;
	badge?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<section className="rounded-xl border border-sidebar-border bg-card p-3 shadow-sm">
			<div className="mb-2 flex items-center gap-2">
				<h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					{title}
				</h3>
				{badge}
			</div>
			{children}
		</section>
	);
}

function FactRow({ label, value }: { label: string; value: React.ReactNode }) {
	return (
		<div className="flex items-baseline justify-between gap-2 text-sm">
			<span className="shrink-0 text-muted-foreground">{label}</span>
			<span className="truncate text-right">{value}</span>
		</div>
	);
}

function RepositorySection({
	repo,
	stats,
}: {
	repo: Repo;
	stats: RepoStats | undefined;
}) {
	const primary = stats?.languages[0];
	return (
		<SectionCard title="Repository">
			<div className="flex flex-col gap-1.5">
				<div className="flex items-center gap-2">
					<LanguageIcon language={primary?.name} className="size-4 shrink-0" />
					<span className="truncate text-sm font-medium">{repo.slug}</span>
					<span className="ml-auto shrink-0 rounded-full border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground">
						{repo.defaultBranch}
					</span>
				</div>
				{/* Primary language only (per the draft) — the full breakdown was
				    noise at this size. */}
				{stats && (
					<div className="flex items-center justify-between text-sm">
						{primary ? (
							<span className="flex items-center gap-1.5">
								<span
									className="size-2 rounded-full"
									style={{ backgroundColor: languageColor(primary.name) }}
								/>
								{primary.name}
							</span>
						) : (
							<span />
						)}
						<span className="text-muted-foreground">
							{stats.fileCount.toLocaleString()} files
						</span>
					</div>
				)}
			</div>
		</SectionCard>
	);
}

function SessionSection({ session }: { session: SessionView }) {
	return (
		<SectionCard title="Current session">
			<div className="flex flex-col gap-1">
				<FactRow label="Started" value={formatDateTime(session.createdAt)} />
				<FactRow label="Last active" value={timeAgo(session.lastActiveAt)} />
			</div>
		</SectionCard>
	);
}

function ChangedFilesSection({
	files,
	error,
}: {
	files: ChangedFile[];
	error: string | null;
}) {
	const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
	const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

	return (
		<SectionCard
			title="Changed files"
			badge={
				<>
					{files.length > 0 && (
						<span className="rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
							{files.length}
						</span>
					)}
					{(totalAdditions > 0 || totalDeletions > 0) && (
						<span className="ml-auto shrink-0 font-mono text-xs">
							<span className="text-emerald-600 dark:text-emerald-400">
								+{totalAdditions}
							</span>{" "}
							<span className="text-red-600 dark:text-red-400">
								-{totalDeletions}
							</span>
						</span>
					)}
				</>
			}
		>
			{error ? (
				<p className="text-sm text-red-500">{error}</p>
			) : files.length === 0 ? (
				<p className="text-sm text-muted-foreground">No changes yet.</p>
			) : (
				<ul className="space-y-0.5">
					{files.map((file) => (
						<ChangedFileRow key={file.path} file={file} />
					))}
				</ul>
			)}
		</SectionCard>
	);
}

const STATUS_META: Record<
	ChangedFile["status"],
	{ icon: typeof FilePlus; className: string; label: string }
> = {
	added: {
		icon: FilePlus,
		className: "text-emerald-600 dark:text-emerald-400",
		label: "Added",
	},
	modified: {
		icon: Pencil,
		className: "text-amber-600 dark:text-amber-400",
		label: "Modified",
	},
	deleted: {
		icon: FileX,
		className: "text-red-600 dark:text-red-400",
		label: "Deleted",
	},
};

function ChangedFileRow({ file }: { file: ChangedFile }) {
	const meta = STATUS_META[file.status] ?? {
		icon: FileDiff,
		className: "text-muted-foreground",
		label: file.status,
	};
	const Icon = meta.icon;
	return (
		<li
			className="flex items-center gap-2 rounded-md py-1 text-sm"
			title={`${meta.label}: ${file.path}`}
		>
			<Icon className={`size-3.5 shrink-0 ${meta.className}`} />
			<span className="truncate font-mono text-xs">{file.path}</span>
			<span className="ml-auto shrink-0 whitespace-nowrap font-mono text-xs">
				{file.additions > 0 && (
					<span className="text-emerald-600 dark:text-emerald-400">
						+{file.additions}
					</span>
				)}
				{file.additions > 0 && file.deletions > 0 && " "}
				{file.deletions > 0 && (
					<span className="text-red-600 dark:text-red-400">
						-{file.deletions}
					</span>
				)}
			</span>
		</li>
	);
}

function CommitsSection({ commits }: { commits: CommitInfo[] }) {
	return (
		<SectionCard title="Recent commits">
			{commits.length === 0 ? (
				<p className="text-sm text-muted-foreground">No commits.</p>
			) : (
				<ul className="space-y-1.5">
					{commits.map((c) => (
						<li key={c.hash} className="flex items-start gap-2">
							<GitCommitHorizontal className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
							<div className="min-w-0 flex-1">
								<p className="truncate text-sm" title={c.subject}>
									{c.subject}
								</p>
								<p className="font-mono text-xs text-muted-foreground">
									{c.hash}
									<span className="ml-2 font-sans">
										{timeAgo(c.authoredAt)}
									</span>
								</p>
							</div>
						</li>
					))}
				</ul>
			)}
		</SectionCard>
	);
}
