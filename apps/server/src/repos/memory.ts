import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { repoMemory as repoMemoryTable } from "../db/schema";

/**
 * Hard cap on a Repo's persisted memory (issue #59), matching the size bound
 * the issue's discussion settled on. Enforced here, the single write path
 * (`setRepoMemory`), rather than in the DB column or the SDK tool schema, so
 * every caller — the tool handler today, anything else later — gets the same
 * answer instead of a truncated write.
 */
export const REPO_MEMORY_MAX_CHARS = 2200;

export async function getRepoMemory(repoId: string): Promise<string> {
	const db = getDb();
	const row = db
		.select()
		.from(repoMemoryTable)
		.where(eq(repoMemoryTable.repoId, repoId))
		.get();
	return row?.content ?? "";
}

/**
 * Replace (not merge) a Repo's memory. Whole-content replacement, matching
 * how the `update_repo_memory` tool is documented to callers — the agent
 * reads the current content from its own system prompt, edits it, and sends
 * the full result back, so there's no partial-entry merge logic to keep in
 * sync between here and the tool description.
 *
 * No approval gate: per the discussion on issue #59, dilna has no
 * notification/prompt system yet, so this writes straight through. Kept as
 * the single function every write goes through (rather than inlining the
 * upsert at each call site) so a gate can be added here later without
 * touching callers.
 */
export async function setRepoMemory(
	repoId: string,
	content: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	if (content.length > REPO_MEMORY_MAX_CHARS) {
		return {
			ok: false,
			error: `Memory content is ${content.length} characters, over the ${REPO_MEMORY_MAX_CHARS}-character limit. Trim it — keep only short, durable facts — and try again.`,
		};
	}

	const db = getDb();
	db.insert(repoMemoryTable)
		.values({ repoId, content })
		.onConflictDoUpdate({
			target: repoMemoryTable.repoId,
			set: { content, updatedAt: Math.floor(Date.now() / 1000) },
		})
		.run();
	return { ok: true };
}
