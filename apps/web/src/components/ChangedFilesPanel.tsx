import type { ChangedFile } from "@dilna/shared";
import { FileDiff, FilePlus, FileX, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "@/api/client";

type Props = {
	sessionId: string;
};

/**
 * "Changed files" panel: always visible next to the chat on desktop (no
 * open/closed toggle, same always-open model as the left Sidebar). Lists
 * every file touched in the current Session's Worktree, diffed against the
 * Repo's default-branch merge-base including uncommitted changes. The diff
 * is recomputed server-side at the end of every turn (see
 * SessionManager.sendMessage) and pushed here via the `changed_files` SSE
 * event — never persisted, never fetched on a manual refresh.
 *
 * Rows are intentionally non-interactive (no click-through diff view — out
 * of scope per the issue).
 */
export function ChangedFilesPanel({ sessionId }: Props) {
	const [files, setFiles] = useState<ChangedFile[]>([]);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		setFiles([]);
		setError(null);

		// Initial snapshot so the panel has content immediately (e.g. resuming
		// a session with prior turns), before any live event arrives.
		api.sessions
			.changedFiles(sessionId)
			.then(({ files }) => {
				if (!cancelled) setFiles(files);
			})
			.catch((e) => {
				if (!cancelled) {
					setError(e instanceof Error ? e.message : "failed to load changes");
				}
			});

		// Own SSE subscription (independent of ChatShell's) kept live for the
		// lifetime of the panel; recomputed files arrive after every turn.
		const unsubscribe = api.sessions.stream(sessionId, (ev) => {
			if (ev.type === "changed_files") setFiles(ev.files);
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [sessionId]);

	const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
	const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

	return (
		<aside className="flex w-72 shrink-0 flex-col border-l border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950">
			<div className="flex h-14 shrink-0 items-center gap-2 border-b border-zinc-200 px-4 dark:border-zinc-800">
				<span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
					Changed files
				</span>
				{files.length > 0 && (
					<span className="rounded-full bg-zinc-200 px-1.5 py-0.5 text-xs font-medium text-muted-foreground dark:bg-zinc-800">
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
			</div>
			<div className="flex-1 overflow-y-auto px-2 py-2">
				{error ? (
					<p className="px-2 py-2 text-sm text-red-500">{error}</p>
				) : files.length === 0 ? (
					<p className="px-2 py-2 text-sm text-muted-foreground">
						No changes yet.
					</p>
				) : (
					<ul className="space-y-0.5">
						{files.map((file) => (
							<ChangedFileRow key={file.path} file={file} />
						))}
					</ul>
				)}
			</div>
		</aside>
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
			className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm"
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
