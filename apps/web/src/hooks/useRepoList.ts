import type { RepoStats, RepoSyncStatus } from "@dilna/shared";
import { useCallback, useEffect, useState } from "react";
import { api, type Repo } from "@/api/client";

/** How often the "N commits behind" check re-runs while the app is open. */
const SYNC_POLL_INTERVAL_MS = 3 * 60_000;

/**
 * The Repo list and everything that hangs off it — issue #174.
 *
 * Four async lifecycles used to sit inline in `App.tsx`, ~200 lines apart,
 * each with its own cancellation idiom and its own error convention. They are
 * one thing, because they're all keyed on the same list and all re-run when it
 * changes:
 *
 * 1. **The list itself** (`api.repos.list`) — the only one whose failure the
 *    user sees, via `error`. A failed initial load means an empty sidebar, so
 *    it needs saying out loud.
 * 2. **The pull** (`pull`) — `Promise.allSettled` across every Repo's remote,
 *    so an unreachable remote can't block the others, then a re-list. Partial
 *    failure is *aggregated* into the same `error` banner ("failed to pull 2
 *    of 5 repositories") rather than surfacing per-Repo: the user asked for
 *    one refresh, they get one verdict. Tracked by its own `pulling` flag
 *    rather than `loading` — it takes seconds (a network fetch per Repo) and
 *    the sidebar already holds a rendered list, so it drives a spinning icon
 *    instead of the initial-load skeleton, and guards against a second
 *    concurrent pull.
 * 3. **Language stats** (`statsByRepoId`) — decorative (sidebar icons, the
 *    context panel). Failure is swallowed: the Repo keeps its generic icon.
 * 4. **Sync status** (`syncStatusByRepoId`) — the "N commits behind" badge,
 *    VS Code-style. Entirely client-driven (no server-side timer) so it only
 *    runs while the app is open: once per list change (covering the initial
 *    load and the end of a `pull`, which replaces the list) and then every
 *    three minutes. Failure is swallowed *deliberately and differently* from
 *    (3): the previous status is left in place, so a Repo whose remote is
 *    briefly unreachable keeps its last-known badge instead of flickering
 *    back to "up to date" — which would be a lie.
 *
 * Both polls use the same cancellation idiom: a `cancelled` flag closed over
 * by the effect, checked before every `setState`, so a list change mid-flight
 * can't write a stale entry into the map.
 *
 * The seam is this return value: `renderHook` against a mocked `api` exercises
 * all four, with no Sidebar, ChatShell or dialog rendered.
 */
export function useRepoList() {
	const [repos, setRepos] = useState<Repo[]>([]);
	const [loading, setLoading] = useState(true);
	// Distinct from `loading` (the initial fetch) — see the doc comment.
	const [pulling, setPulling] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [statsByRepoId, setStatsByRepoId] = useState<Record<string, RepoStats>>(
		{},
	);
	const [syncStatusByRepoId, setSyncStatusByRepoId] = useState<
		Record<string, RepoSyncStatus>
	>({});

	const reload = useCallback(async () => {
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

	// Sidebar's refresh button: pull every Repo's default branch from its
	// origin remote (a bare clone otherwise has no way to pick up upstream
	// commits — see RepoManager.pull) before reloading the list.
	const pull = useCallback(async () => {
		if (pulling) return;
		setPulling(true);
		setError(null);
		try {
			const results = await Promise.allSettled(
				repos.map((r) => api.repos.pull(r.id)),
			);
			const failed = results.filter((r) => r.status === "rejected").length;
			if (failed > 0) {
				setError(
					`failed to pull ${failed} of ${results.length} repositor${results.length === 1 ? "y" : "ies"}`,
				);
			}
			try {
				const { repos: updated } = await api.repos.list();
				setRepos(updated);
			} catch (e) {
				setError(e instanceof Error ? e.message : "failed to load repos");
			}
		} finally {
			setPulling(false);
		}
	}, [repos, pulling]);

	useEffect(() => {
		reload();
	}, [reload]);

	// Language/file stats per Repo. Refetched whenever the list changes
	// (initial load, clone, pull) — a failed Repo just keeps its generic icon.
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

	// Periodic "N commits behind" check per Repo — a Repo whose remote is
	// unreachable keeps its last-known badge instead of clearing it.
	useEffect(() => {
		if (repos.length === 0) return;
		let cancelled = false;
		const checkAll = () => {
			for (const repo of repos) {
				api.repos
					.sync(repo.id)
					.then(({ status }) => {
						if (cancelled) return;
						setSyncStatusByRepoId((prev) => ({ ...prev, [repo.id]: status }));
					})
					.catch(() => {});
			}
		};
		checkAll();
		const interval = setInterval(checkAll, SYNC_POLL_INTERVAL_MS);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [repos]);

	return {
		repos,
		/// True only for the initial/explicit `reload` fetch — `pulling` covers
		/// the refresh button, which must not show the load skeleton.
		loading,
		pulling,
		/// The single user-visible failure channel: a failed list fetch, or an
		/// aggregate count from a partially-failed `pull`. Stats and sync
		/// failures never reach it.
		error,
		statsByRepoId,
		syncStatusByRepoId,
		/// Re-fetch the list (initial mount, and after a clone).
		reload,
		/// Pull every Repo's remote, then re-list. No-op while one is running.
		pull,
	};
}
