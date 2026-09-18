import type { RepoStats, RepoSyncStatus } from "@dilna/shared";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRepoList } from "@/hooks/useRepoList";
import type { PartialApi } from "@/test/api-mock";
import { makeRepo } from "@/test/factories";

/**
 * The polling/cancellation/partial-failure semantics `useRepoList` owns
 * (issue #174). These rules used to live as comments above inline effects in
 * `App.tsx` with no test, because reaching them meant rendering the whole app
 * with Sidebar, ChatShell and dialogs attached. The hook's return value is the
 * seam: a mocked `api` is the only thing needed here.
 */

const REPO_A = makeRepo();
const REPO_B = makeRepo({ id: "repo-2", slug: "other" });

const EMPTY_STATS: RepoStats = { languages: [], fileCount: 0 };

function syncStatus(behind: number): RepoSyncStatus {
	return { ahead: 0, behind };
}

const mocks = vi.hoisted(() => ({
	list: vi.fn(),
	pull: vi.fn(),
	stats: vi.fn(),
	sync: vi.fn(),
}));

vi.mock("@/api/client", () => ({
	api: {
		repos: {
			list: (...args: unknown[]) => mocks.list(...args),
			pull: (...args: unknown[]) => mocks.pull(...args),
			stats: (...args: unknown[]) => mocks.stats(...args),
			sync: (...args: unknown[]) => mocks.sync(...args),
		},
	} satisfies PartialApi,
}));

beforeEach(() => {
	// A fresh array per call: the sync/stats effects key on `repos` identity,
	// so a re-list that returns the very same array reference (as a shared
	// literal would) wouldn't re-run them the way a real fetch does.
	mocks.list.mockReset().mockImplementation(async () => ({
		repos: [REPO_A, REPO_B],
	}));
	mocks.pull.mockReset().mockResolvedValue({});
	mocks.stats.mockReset().mockResolvedValue({ stats: EMPTY_STATS });
	mocks.sync.mockReset().mockResolvedValue({ status: syncStatus(0) });
});

afterEach(() => {
	vi.useRealTimers();
});

/** Makes `api.repos.pull` hang until released, so a test can observe the
 * in-flight window. Every call gets its own resolver — one shared `release`
 * would be overwritten by the second Repo's call and deadlock the first. */
function pendingPulls() {
	const resolvers: Array<() => void> = [];
	mocks.pull.mockImplementation(
		() =>
			new Promise<unknown>((resolve) => {
				resolvers.push(() => resolve({}));
			}),
	);
	return {
		releaseAll: () => {
			for (const resolve of resolvers) resolve();
		},
	};
}

describe("useRepoList — the list", () => {
	it("loads on mount and lowers `loading` when it lands", async () => {
		const { result } = renderHook(() => useRepoList());
		expect(result.current.loading).toBe(true);

		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.repos).toEqual([REPO_A, REPO_B]);
		expect(result.current.error).toBeNull();
	});

	it("surfaces a failed list fetch, since an empty sidebar needs explaining", async () => {
		mocks.list.mockRejectedValue(new Error("connection refused"));
		const { result } = renderHook(() => useRepoList());

		await waitFor(() =>
			expect(result.current.error).toBe("connection refused"),
		);
		expect(result.current.loading).toBe(false);
	});
});

describe("useRepoList — pull", () => {
	it("pulls every Repo, then re-lists", async () => {
		const { result } = renderHook(() => useRepoList());
		await waitFor(() => expect(result.current.loading).toBe(false));
		mocks.list.mockResolvedValue({ repos: [REPO_A] });

		await act(async () => {
			await result.current.pull();
		});

		expect(mocks.pull).toHaveBeenCalledWith(REPO_A.id);
		expect(mocks.pull).toHaveBeenCalledWith(REPO_B.id);
		expect(result.current.repos).toEqual([REPO_A]);
		expect(result.current.error).toBeNull();
	});

	it("an unreachable remote doesn't block the other Repos from updating", async () => {
		const { result } = renderHook(() => useRepoList());
		await waitFor(() => expect(result.current.loading).toBe(false));
		mocks.pull.mockImplementation(async (id: string) => {
			if (id === REPO_A.id) throw new Error("could not resolve host");
			return {};
		});

		await act(async () => {
			await result.current.pull();
		});

		// The healthy Repo was still pulled, and the list still refreshed.
		expect(mocks.pull).toHaveBeenCalledWith(REPO_B.id);
		expect(result.current.repos).toEqual([REPO_A, REPO_B]);
		// Partial failure is aggregated into one banner, not one per Repo.
		expect(result.current.error).toBe("failed to pull 1 of 2 repositories");
	});

	it("pluralises the aggregate failure for a single Repo", async () => {
		mocks.list.mockResolvedValue({ repos: [REPO_A] });
		mocks.pull.mockRejectedValue(new Error("nope"));
		const { result } = renderHook(() => useRepoList());
		await waitFor(() => expect(result.current.loading).toBe(false));

		await act(async () => {
			await result.current.pull();
		});

		expect(result.current.error).toBe("failed to pull 1 of 1 repository");
	});

	it("drives `pulling`, not `loading` — the sidebar keeps its rendered list", async () => {
		const { result } = renderHook(() => useRepoList());
		await waitFor(() => expect(result.current.loading).toBe(false));

		const gate = pendingPulls();

		let pulled!: Promise<void>;
		act(() => {
			pulled = result.current.pull();
		});
		await waitFor(() => expect(result.current.pulling).toBe(true));
		// The initial-load skeleton must not come back over an already-rendered
		// list.
		expect(result.current.loading).toBe(false);

		await act(async () => {
			gate.releaseAll();
			await pulled;
		});
		expect(result.current.pulling).toBe(false);
	});

	it("a second concurrent pull is a no-op", async () => {
		const { result } = renderHook(() => useRepoList());
		await waitFor(() => expect(result.current.loading).toBe(false));

		const gate = pendingPulls();

		let first!: Promise<void>;
		act(() => {
			first = result.current.pull();
		});
		await waitFor(() => expect(result.current.pulling).toBe(true));

		await act(async () => {
			await result.current.pull();
		});
		// Two Repos, one pull round — the second call added nothing.
		expect(mocks.pull).toHaveBeenCalledTimes(2);

		await act(async () => {
			gate.releaseAll();
			await first;
		});
	});
});

describe("useRepoList — stats", () => {
	it("fetches stats per Repo and keys them by id", async () => {
		const languages: RepoStats["languages"] = [
			{ name: "TypeScript", pct: 100 },
		];
		mocks.stats.mockImplementation(async (id: string) => ({
			stats: id === REPO_A.id ? { ...EMPTY_STATS, languages } : EMPTY_STATS,
		}));
		const { result } = renderHook(() => useRepoList());

		await waitFor(() =>
			expect(result.current.statsByRepoId[REPO_A.id]?.languages).toEqual(
				languages,
			),
		);
		expect(result.current.statsByRepoId[REPO_B.id]).toEqual(EMPTY_STATS);
	});

	it("swallows a stats failure — that Repo just keeps its generic icon", async () => {
		mocks.stats.mockImplementation(async (id: string) => {
			if (id === REPO_A.id) throw new Error("not a git repo");
			return { stats: EMPTY_STATS };
		});
		const { result } = renderHook(() => useRepoList());

		await waitFor(() =>
			expect(result.current.statsByRepoId[REPO_B.id]).toEqual(EMPTY_STATS),
		);
		expect(result.current.statsByRepoId[REPO_A.id]).toBeUndefined();
		// Decorative data never reaches the user-visible banner.
		expect(result.current.error).toBeNull();
	});
});

describe("useRepoList — sync status", () => {
	it("checks every Repo once the list lands", async () => {
		mocks.sync.mockImplementation(async (id: string) => ({
			status: syncStatus(id === REPO_A.id ? 3 : 0),
		}));
		const { result } = renderHook(() => useRepoList());

		await waitFor(() =>
			expect(result.current.syncStatusByRepoId[REPO_A.id]?.behind).toBe(3),
		);
		expect(result.current.syncStatusByRepoId[REPO_B.id]?.behind).toBe(0);
	});

	it("a Repo whose remote is unreachable keeps its last-known badge", async () => {
		// The rule that previously existed only as a comment: a failed check
		// must not clear the badge back to "up to date", which would be a lie.
		mocks.sync.mockResolvedValue({ status: syncStatus(4) });
		const { result } = renderHook(() => useRepoList());
		await waitFor(() =>
			expect(result.current.syncStatusByRepoId[REPO_A.id]?.behind).toBe(4),
		);

		mocks.sync.mockRejectedValue(new Error("could not resolve host"));
		// A fresh array, so the re-list actually changes `repos` identity and
		// re-runs the sync effect (as a real pull would).
		mocks.list.mockResolvedValue({ repos: [REPO_A, REPO_B] });
		await act(async () => {
			await result.current.pull();
		});

		await waitFor(() => expect(mocks.sync).toHaveBeenCalledTimes(4));
		expect(result.current.syncStatusByRepoId[REPO_A.id]?.behind).toBe(4);
		expect(result.current.error).toBeNull();
	});

	it("re-checks on an interval while the app is open", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const { result } = renderHook(() => useRepoList());
		await waitFor(() =>
			expect(result.current.syncStatusByRepoId[REPO_A.id]).toBeDefined(),
		);
		expect(mocks.sync).toHaveBeenCalledTimes(2);

		await act(async () => {
			await vi.advanceTimersByTimeAsync(3 * 60_000);
		});
		expect(mocks.sync).toHaveBeenCalledTimes(4);
	});

	it("stops polling once unmounted — no timer outlives the app", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const { result, unmount } = renderHook(() => useRepoList());
		await waitFor(() =>
			expect(result.current.syncStatusByRepoId[REPO_A.id]).toBeDefined(),
		);

		unmount();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3 * 60_000);
		});
		expect(mocks.sync).toHaveBeenCalledTimes(2);
	});

	it("doesn't poll an empty list", async () => {
		mocks.list.mockResolvedValue({ repos: [] });
		const { result } = renderHook(() => useRepoList());

		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(mocks.sync).not.toHaveBeenCalled();
	});

	it("a check still in flight when the list changes can't write a stale entry", async () => {
		// The `cancelled` flag: a resolution arriving after the list has been
		// replaced belongs to a superseded generation and must be dropped.
		let releaseStale!: (status: RepoSyncStatus) => void;
		mocks.sync.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					releaseStale = (status) => resolve({ status });
				}),
		);
		mocks.sync.mockResolvedValue({ status: syncStatus(0) });

		const { result } = renderHook(() => useRepoList());
		await waitFor(() => expect(result.current.loading).toBe(false));
		await waitFor(() => expect(releaseStale).toBeDefined());

		// Replace the list, retiring the in-flight generation.
		mocks.list.mockResolvedValue({ repos: [REPO_B] });
		await act(async () => {
			await result.current.pull();
		});

		await act(async () => {
			releaseStale(syncStatus(99));
		});
		expect(result.current.syncStatusByRepoId[REPO_A.id]).toBeUndefined();
	});
});
