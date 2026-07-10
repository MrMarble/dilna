export type Repo = {
	id: string;
	slug: string;
	path: string;
	defaultBranch: string;
	remoteUrl: string;
	createdAt: number;
};

export type CloneRepoInput = {
	url: string;
	slug?: string;
};

/** One language's share of a Repo's code, GitHub-style: percentage of
 * blob bytes across recognized code extensions (docs/config/lockfiles are
 * excluded server-side — see repos/languages.ts). */
export type LanguageStat = {
	name: string;
	/** 0-100, one decimal. Shares of all recognized languages sum to ~100. */
	pct: number;
};

/** Lightweight repo facts for the context panel and sidebar language icons.
 * Computed on demand from the bare clone's HEAD tree (never the worktrees). */
export type RepoStats = {
	/** Total files in the default branch's tree (all files, not only code). */
	fileCount: number;
	/** Recognized languages by byte share, descending. Empty when nothing is
	 * recognized (e.g. a docs-only repo). */
	languages: LanguageStat[];
};

/** One commit in a Session's Worktree history (`git log`), newest first. */
export type CommitInfo = {
	/** Abbreviated hash. */
	hash: string;
	subject: string;
	/** Epoch seconds. */
	authoredAt: number;
};
