/**
 * A single file's change relative to the Repo's default-branch merge-base,
 * as shown in the Session's "Changed files" panel (see ADR-0006 for the
 * event union this rides on). Computed fresh from git at the end of every
 * turn — never persisted.
 */
export type ChangedFileStatus = "added" | "modified" | "deleted";

export type ChangedFile = {
	/** Worktree-relative path. For renames, the new path (see status below). */
	path: string;
	/**
	 * Renames are normalized to "modified" at the new path rather than a
	 * delete+add pair (per the "Changed files" panel spec) — dilna doesn't
	 * surface rename-specific UI.
	 */
	status: ChangedFileStatus;
	additions: number;
	deletions: number;
};
