import type { Repo, SessionStatus, SessionView } from "@dilna/shared";
import { ArrowLeft, Columns2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type ComparisonView as ComparisonData } from "@/api/client";
import { ChatShell } from "@/components/ChatShell";
import { StatusDot } from "@/components/StatusDot";
import { Spinner } from "@/components/ui/spinner";
import { assistantDisplayName } from "@/lib/agent-labels";
import { cn } from "@/lib/utils";

type Props = {
	/** The Comparison's group id — the `/compare/<groupId>` route param. */
	groupId: string;
	repos: Repo[];
	isDesktop: boolean;
	/** Same "standalone view back arrow" contract as Metrics/Settings:
	 * browser history when there is any, home otherwise. */
	onBack: () => void;
};

/**
 * The comparison view (issue #250, ADR-0047): one column per arm, each an
 * ordinary `ChatShell` on its own Session. Desktop renders the arms side by
 * side, each with its own composer — a follow-up goes to whichever arm (or
 * arms) the user types into. Below the breakpoint one arm shows at a time,
 * switched by a pill rendered on top of the composer (ChatShell's
 * `composerHeader` slot), so "the active model" is always what the input box
 * addresses.
 *
 * Inactive mobile columns stay mounted but hidden rather than unmounted:
 * each arm's SSE subscription keeps running, so switching back is instant
 * and loses nothing — the same reasoning that keeps the desktop Sidebar a
 * mounted column rather than a conditional render.
 */
export function ComparisonView({ groupId, repos, isDesktop, onBack }: Props) {
	const [comparison, setComparison] = useState<ComparisonData | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [activeIdx, setActiveIdx] = useState(0);

	// The column header's status dots and the pill stay current off the
	// cross-session stream (the same source the sidebar folds), instead of
	// ChatShell lifting live status up through a prop.
	const [statusById, setStatusById] = useState<
		Record<string, SessionStatus | undefined>
	>({});
	useEffect(() => {
		return api.sessionList.stream((ev) => {
			if (ev.type === "session_status") {
				setStatusById((prev) => ({
					...prev,
					[ev.session.id]: ev.session.status,
				}));
			}
		});
	}, []);

	useEffect(() => {
		setComparison(null);
		setError(null);
		setActiveIdx(0);
		let cancelled = false;
		api.comparisons
			.get(groupId)
			.then(({ comparison }) => {
				if (!cancelled) setComparison(comparison);
			})
			.catch((e) => {
				if (!cancelled) {
					setError(
						e instanceof Error ? e.message : "failed to load comparison",
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [groupId]);

	const repo = comparison
		? (repos.find((r) => r.id === comparison.repoId) ?? null)
		: null;

	return (
		<div className="flex flex-1 flex-col overflow-hidden">
			<div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
				<button
					type="button"
					onClick={onBack}
					title="Back"
					aria-label="Back"
					className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<ArrowLeft className="size-4" />
				</button>
				<Columns2 className="size-4 text-muted-foreground" />
				<span className="text-sm font-medium">Model comparison</span>
				{repo && (
					<span className="truncate text-xs text-muted-foreground">
						· {repo.slug}
					</span>
				)}
			</div>
			{error ? (
				<div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
					{error}
				</div>
			) : !comparison ? (
				<div className="flex flex-1 items-center justify-center">
					<Spinner className="size-5 text-muted-foreground" />
				</div>
			) : (
				<div className="flex flex-1 overflow-hidden">
					{comparison.sessions.map((session, i) => (
						<ComparisonColumn
							key={session.id}
							session={session}
							sessions={comparison.sessions}
							active={isDesktop || i === activeIdx}
							activeIdx={activeIdx}
							onSelect={setActiveIdx}
							isDesktop={isDesktop}
							status={statusById[session.id] ?? session.status}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function ComparisonColumn({
	session,
	sessions,
	active,
	activeIdx,
	onSelect,
	isDesktop,
	status,
}: {
	session: SessionView;
	sessions: SessionView[];
	active: boolean;
	/** Index of the mobile-active arm — every column's pill reads it so a
	 * given pill always highlights the arm the input box addresses. */
	activeIdx: number;
	onSelect: (index: number) => void;
	isDesktop: boolean;
	status: SessionStatus;
}) {
	return (
		// `hidden` (not unmount) keeps the hidden arms' streams and scroll
		// state alive — see the component doc comment.
		<div
			className={cn(
				"min-w-0 flex-col overflow-hidden",
				isDesktop
					? "flex flex-1 border-l border-border first:border-l-0"
					: cn("flex-1", active ? "flex" : "hidden"),
			)}
		>
			{isDesktop && (
				<div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
					<StatusDot status={status} />
					<span className="truncate text-xs font-medium">
						{assistantDisplayName(session.model, session.agentType)}
					</span>
				</div>
			)}
			<ChatShell
				sessionId={session.id}
				session={session}
				isDesktop={isDesktop}
				composerHeader={
					isDesktop ? undefined : (
						<ModelPill
							sessions={sessions}
							activeIdx={activeIdx}
							onSelect={onSelect}
						/>
					)
				}
			/>
		</div>
	);
}

/** The mobile arm switcher: a segmented pill rendered by the active column's
 * composer (via ChatShell's `composerHeader` slot), directly on top of the
 * input box it controls. Only rendered below the desktop breakpoint. */
function ModelPill({
	sessions,
	activeIdx,
	onSelect,
}: {
	sessions: SessionView[];
	activeIdx: number;
	onSelect: (index: number) => void;
}) {
	return (
		<div className="flex justify-center pb-1">
			<div
				role="tablist"
				aria-label="Active model"
				className="flex items-center gap-0.5 rounded-full border border-border bg-muted/60 p-0.5"
			>
				{sessions.map((s, i) => (
					<button
						key={s.id}
						type="button"
						role="tab"
						aria-selected={i === activeIdx}
						onClick={() => onSelect(i)}
						className={cn(
							"max-w-[9rem] truncate rounded-full px-3 py-1 text-xs font-medium transition-colors",
							i === activeIdx
								? "bg-background text-foreground shadow-sm"
								: "text-muted-foreground hover:text-foreground",
						)}
					>
						{assistantDisplayName(s.model, s.agentType)}
					</button>
				))}
			</div>
		</div>
	);
}
