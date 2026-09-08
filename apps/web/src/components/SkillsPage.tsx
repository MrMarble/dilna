import type { Repo, RepoSkill, SkillSearchResult } from "@dilna/shared";
import { ArrowLeft, Download, Loader2, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Props = {
	repos: Repo[];
	onBack: () => void;
};

function formatInstalls(n: number): string {
	if (n >= 1_000_000)
		return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
	return String(n);
}

/**
 * Skill management (issue #60).
 *
 * The page's shape follows the storage model exactly: skills install **once,
 * globally** (one copy on disk, one catalog row), and are then **enabled
 * per-Repo**. So there's a single list of installed skills, and a Repo
 * selector that switches which Repo the enable toggles apply to — rather than
 * a per-Repo library that would imply installing the same skill N times.
 *
 * A freshly installed skill is off everywhere until toggled on, which is why
 * install and enable are visibly separate actions here.
 */
export function SkillsPage({ repos, onBack }: Props) {
	const [skills, setSkills] = useState<RepoSkill[]>([]);
	const [loading, setLoading] = useState(true);
	const [selectedRepoId, setSelectedRepoId] = useState<string | null>(
		repos[0]?.id ?? null,
	);

	const [installUrl, setInstallUrl] = useState("");
	const [installing, setInstalling] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	const [query, setQuery] = useState("");
	const [results, setResults] = useState<SkillSearchResult[]>([]);
	const [searching, setSearching] = useState(false);

	// Keep a Repo selected as repos load in / the current one disappears.
	useEffect(() => {
		if (repos.length === 0) {
			setSelectedRepoId(null);
			return;
		}
		if (!selectedRepoId || !repos.some((r) => r.id === selectedRepoId)) {
			setSelectedRepoId(repos[0]?.id ?? null);
		}
	}, [repos, selectedRepoId]);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			// Without a Repo there's nothing to scope enablement to, so fall back
			// to the plain global catalog (everything reads as disabled).
			if (selectedRepoId) {
				const res = await api.skills.forRepo(selectedRepoId);
				setSkills(res.skills);
			} else {
				const res = await api.skills.list();
				setSkills(res.skills.map((s) => ({ ...s, enabled: false })));
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to load skills.");
		} finally {
			setLoading(false);
		}
	}, [selectedRepoId]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const install = useCallback(
		async (url: string) => {
			if (!url.trim()) return;
			setInstalling(true);
			setError(null);
			setNotice(null);
			try {
				const res = await api.skills.install(url.trim());
				setInstallUrl("");
				setNotice(
					`Installed "${res.skill.name}". Enable it for the repos you want it in.`,
				);
				await refresh();
			} catch (err) {
				setError(err instanceof Error ? err.message : "Install failed.");
			} finally {
				setInstalling(false);
			}
		},
		[refresh],
	);

	const search = useCallback(async () => {
		if (query.trim().length < 2) return;
		setSearching(true);
		try {
			const res = await api.skills.search(query.trim());
			setResults(res.results);
		} catch {
			setResults([]);
		} finally {
			setSearching(false);
		}
	}, [query]);

	const toggle = useCallback(
		async (skill: RepoSkill) => {
			if (!selectedRepoId) return;
			// Optimistic: the toggle is a single boolean row write, and snapping
			// back on error is less jarring than a spinner per row.
			setSkills((prev) =>
				prev.map((s) =>
					s.id === skill.id ? { ...s, enabled: !s.enabled } : s,
				),
			);
			try {
				await api.skills.setEnabled(skill.id, selectedRepoId, !skill.enabled);
			} catch (err) {
				setSkills((prev) =>
					prev.map((s) =>
						s.id === skill.id ? { ...s, enabled: skill.enabled } : s,
					),
				);
				setError(err instanceof Error ? err.message : "Failed to update.");
			}
		},
		[selectedRepoId],
	);

	const uninstall = useCallback(
		async (skill: RepoSkill) => {
			if (
				!confirm(
					`Uninstall "${skill.name}"? It will be removed for every repo that has it enabled.`,
				)
			)
				return;
			try {
				await api.skills.uninstall(skill.id);
				await refresh();
			} catch (err) {
				setError(err instanceof Error ? err.message : "Uninstall failed.");
			}
		},
		[refresh],
	);

	const installedIds = useMemo(
		() => new Set(skills.map((s) => s.id)),
		[skills],
	);
	const enabledCount = skills.filter((s) => s.enabled).length;

	return (
		<div className="flex h-full flex-col overflow-y-auto">
			<div className="flex items-center gap-2 border-b px-4 py-3">
				<Button variant="ghost" size="sm" onClick={onBack}>
					<ArrowLeft className="size-4" />
				</Button>
				<h1 className="font-semibold text-lg">Skills</h1>
			</div>

			<div className="mx-auto w-full max-w-3xl space-y-6 p-4">
				<p className="text-muted-foreground text-sm">
					Skills are reusable procedures an agent loads when relevant. They're
					installed once here, then enabled per repo — there's only ever one
					copy on disk.
				</p>

				{error && (
					<div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-destructive text-sm">
						{error}
					</div>
				)}
				{notice && (
					<div className="rounded-md border px-3 py-2 text-muted-foreground text-sm">
						{notice}
					</div>
				)}

				<section className="space-y-2">
					<h2 className="font-medium text-sm">Install a skill</h2>
					<div className="flex gap-2">
						<Input
							placeholder="https://www.skills.sh/owner/repo/skill or a GitHub URL"
							value={installUrl}
							onChange={(e) => setInstallUrl(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") void install(installUrl);
							}}
						/>
						<Button
							onClick={() => void install(installUrl)}
							disabled={installing || !installUrl.trim()}
						>
							{installing ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								<Download className="size-4" />
							)}
							Install
						</Button>
					</div>
				</section>

				<section className="space-y-2">
					<h2 className="font-medium text-sm">Search skills.sh</h2>
					<div className="flex gap-2">
						<Input
							placeholder="Search the registry…"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") void search();
							}}
						/>
						<Button
							variant="secondary"
							onClick={() => void search()}
							disabled={searching || query.trim().length < 2}
						>
							{searching ? (
								<Loader2 className="size-4 animate-spin" />
							) : (
								<Search className="size-4" />
							)}
							Search
						</Button>
					</div>

					{results.length > 0 && (
						<ul className="divide-y rounded-md border">
							{results.map((r) => (
								<li
									key={r.id}
									className="flex items-center justify-between gap-3 px-3 py-2"
								>
									<div className="min-w-0">
										<div className="truncate font-medium text-sm">{r.name}</div>
										<div className="truncate text-muted-foreground text-xs">
											{r.source} · {formatInstalls(r.installs)} installs
										</div>
									</div>
									<Button
										size="sm"
										variant="ghost"
										disabled={installing || installedIds.has(r.id)}
										onClick={() =>
											void install(`https://www.skills.sh/${r.id}`)
										}
									>
										{installedIds.has(r.id) ? "Installed" : "Install"}
									</Button>
								</li>
							))}
						</ul>
					)}
				</section>

				<section className="space-y-2">
					<div className="flex items-center justify-between gap-3">
						<h2 className="font-medium text-sm">
							Installed skills{" "}
							<span className="font-normal text-muted-foreground">
								({skills.length})
							</span>
						</h2>
						{repos.length > 0 && (
							<label className="flex items-center gap-2 text-muted-foreground text-xs">
								Enabled for
								<select
									className="rounded-md border bg-background px-2 py-1 text-foreground text-xs"
									value={selectedRepoId ?? ""}
									onChange={(e) => setSelectedRepoId(e.target.value)}
								>
									{repos.map((r) => (
										<option key={r.id} value={r.id}>
											{r.slug}
										</option>
									))}
								</select>
							</label>
						)}
					</div>

					{selectedRepoId && skills.length > 0 && (
						<p className="text-muted-foreground text-xs">
							{enabledCount} of {skills.length} enabled for this repo.
						</p>
					)}

					{loading ? (
						<div className="flex justify-center py-8">
							<Loader2 className="size-5 animate-spin text-muted-foreground" />
						</div>
					) : skills.length === 0 ? (
						<p className="rounded-md border border-dashed px-3 py-6 text-center text-muted-foreground text-sm">
							No skills installed yet.
						</p>
					) : (
						<ul className="divide-y rounded-md border">
							{skills.map((s) => (
								<li key={s.id} className="flex items-start gap-3 px-3 py-3">
									<button
										type="button"
										role="switch"
										aria-checked={s.enabled}
										aria-label={`Enable ${s.name}`}
										disabled={!selectedRepoId}
										onClick={() => void toggle(s)}
										className={cn(
											"mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors",
											s.enabled ? "bg-primary" : "bg-muted",
											!selectedRepoId && "cursor-not-allowed opacity-50",
										)}
									>
										<span
											className={cn(
												"block size-4 rounded-full bg-background transition-transform",
												s.enabled ? "translate-x-4.5" : "translate-x-0.5",
											)}
										/>
									</button>
									<div className="min-w-0 flex-1">
										<div className="truncate font-medium text-sm">{s.name}</div>
										{s.description && (
											<div className="text-muted-foreground text-xs">
												{s.description}
											</div>
										)}
										<a
											href={s.sourceUrl}
											target="_blank"
											rel="noreferrer"
											className="text-muted-foreground text-xs underline-offset-2 hover:underline"
										>
											{s.source}
										</a>
									</div>
									<Button
										size="sm"
										variant="ghost"
										aria-label={`Uninstall ${s.name}`}
										onClick={() => void uninstall(s)}
									>
										<Trash2 className="size-4" />
									</Button>
								</li>
							))}
						</ul>
					)}
				</section>
			</div>
		</div>
	);
}
