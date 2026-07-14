/**
 * One-off maintenance: relink Sessions to their Claude-native transcripts
 * and backfill missing history (companion to ADR-0014's boot recovery,
 * for sessions damaged *before* that recovery existed — e.g. a first turn
 * interrupted by a restart left `agent_session_id` null and the chat empty
 * even though the transcript holds the whole conversation).
 *
 * For every Session it lists the transcript files under
 * `$CLAUDE_CONFIG_DIR/projects/<munged worktree path>/`, converts each via
 * the same normalizer the server uses, inserts any rows dilna's DB is
 * missing, and points `agent_session_id` at the newest transcript.
 *
 * Dry-run by default — prints what it would change. Pass --apply to write.
 *
 * Deliberately NOT part of the image build. For a containerized deployment,
 * bundle it from the checkout and stream it into the running pod; the only
 * placement constraint is somewhere under /app/apps/server/ so package deps
 * (better-sqlite3 etc.) resolve from the image's own node_modules up the
 * tree. It opens the existing DB directly (no getDb → no migration run, no
 * dependence on the drizzle folder's location):
 *
 *   pnpm --filter @dilna/server exec tsup src/scripts/relink-transcripts.ts \
 *     --format esm --out-dir /tmp/relink-build
 *   kubectl exec -i <pod> -- sh -c 'cat > /app/apps/server/dist/relink-transcripts.js' \
 *     < /tmp/relink-build/relink-transcripts.js
 *   kubectl exec <pod> -- node apps/server/dist/relink-transcripts.js           # dry-run
 *   kubectl exec <pod> -- node apps/server/dist/relink-transcripts.js --apply
 *   kubectl exec <pod> -- rm apps/server/dist/relink-transcripts.js
 *
 * The container's own env (DILNA_DATA_DIR=/data, derived CLAUDE_CONFIG_DIR)
 * matches the server's, so no flags are needed there. Don't run it through
 * an agent session's Bash tool instead — the sandbox mounts everything
 * outside the worktree read-only, and even opening the WAL-mode DB needs
 * write access.
 *
 * For a bare-host dev instance, run it exactly like the server (same
 * DILNA_DATA_DIR / CLAUDE_CONFIG_DIR, server ideally stopped):
 *
 *   DILNA_DATA_DIR=data CLAUDE_CONFIG_DIR=$HOME/.claude \
 *     pnpm --filter @dilna/server exec tsx src/scripts/relink-transcripts.ts [--apply]
 */
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import Database from "better-sqlite3";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
// Imported for its side effect too: sets CLAUDE_CONFIG_DIR from
// DILNA_DATA_DIR when unset, same as the server (see db/index.ts).
import { getDbPath } from "../db";
import {
	messages as messagesTable,
	sessions as sessionsTable,
} from "../db/schema";
import { claudeMessagesToDilna } from "../sessions/manager";

const apply = process.argv.includes("--apply");

/** Same project-key munging the Claude CLI uses for its per-cwd transcript
 * dirs (non-alphanumerics → '-', on the realpath'd cwd). Long paths get a
 * truncation+hash suffix upstream; not replicated here — if the dir isn't
 * found the session is reported and skipped, never guessed at. */
function projectDir(configDir: string, worktreePath: string): string {
	let resolved = worktreePath;
	try {
		resolved = realpathSync(worktreePath);
	} catch {
		// worktree may be gone; fall back to the stored path
	}
	const key = resolved.replace(/[^a-zA-Z0-9]/g, "-");
	return path.join(configDir, "projects", key);
}

async function main() {
	// Open the server's existing DB directly — never create one: an empty DB
	// appearing here would mean the env doesn't match the server's.
	const dbPath = getDbPath();
	const db = drizzle(new Database(dbPath, { fileMustExist: true }));
	console.log(`db: ${dbPath}`);
	const configDir = process.env.CLAUDE_CONFIG_DIR;
	if (!configDir) throw new Error("CLAUDE_CONFIG_DIR unresolved");
	console.log(`transcripts from: ${path.join(configDir, "projects")}`);
	console.log(apply ? "mode: APPLY" : "mode: dry-run (pass --apply to write)");

	const sessions = db.select().from(sessionsTable).all();
	for (const session of sessions) {
		const label = `${session.id} ("${session.title.slice(0, 40)}")`;
		const dir = projectDir(configDir, session.worktreePath);
		if (!existsSync(dir)) {
			console.log(`- ${label}: no transcript dir, skipping (${dir})`);
			continue;
		}
		// Oldest first so synthesized timestamps of backfilled batches keep
		// transcript order; newest last becomes the resume target.
		const candidates = readdirSync(dir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => ({
				id: f.slice(0, -".jsonl".length),
				mtime: statSync(path.join(dir, f)).mtimeMs,
			}))
			.sort((a, b) => a.mtime - b.mtime);
		if (candidates.length === 0) {
			console.log(`- ${label}: transcript dir empty, skipping`);
			continue;
		}

		const persisted = db
			.select()
			.from(messagesTable)
			.where(eq(messagesTable.sessionId, session.id))
			.orderBy(asc(messagesTable.createdAt))
			.all();
		const existing = new Set(persisted.map((m) => m.id));
		let maxExisting = Math.max(0, ...persisted.map((m) => m.createdAt));
		let inserted = 0;

		for (const candidate of candidates) {
			let raw: Awaited<ReturnType<typeof getSessionMessages>>;
			try {
				raw = await getSessionMessages(candidate.id, {
					dir: session.worktreePath,
				});
			} catch (err) {
				console.log(`  ! ${candidate.id}: unreadable (${err})`);
				continue;
			}
			const fresh = claudeMessagesToDilna(session.id, raw).filter(
				(m) => !existing.has(m.id),
			);
			if (fresh.length === 0) continue;
			// Keep createdAt monotonic vs already-persisted rows (same guard as
			// SessionManager.persistConverted).
			const minFresh = Math.min(...fresh.map((m) => m.createdAt));
			if (minFresh <= maxExisting) {
				const shift = maxExisting + 1 - minFresh;
				for (const m of fresh) m.createdAt += shift;
			}
			maxExisting = Math.max(maxExisting, ...fresh.map((m) => m.createdAt));
			for (const m of fresh) {
				existing.add(m.id);
				inserted++;
				if (apply) {
					db.insert(messagesTable)
						.values({
							id: m.id,
							sessionId: session.id,
							role: m.role,
							partsJson: JSON.stringify(m.parts),
							createdAt: m.createdAt,
						})
						.run();
				}
			}
			console.log(
				`  + ${candidate.id}: ${fresh.length} missing row(s)${apply ? " inserted" : ""}`,
			);
		}

		const newest = candidates[candidates.length - 1];
		const relink = newest && session.agentSessionId !== newest.id;
		if (relink && apply) {
			db.update(sessionsTable)
				.set({ agentSessionId: newest.id })
				.where(eq(sessionsTable.id, session.id))
				.run();
		}
		console.log(
			`- ${label}: ${inserted} row(s) ${apply ? "inserted" : "to insert"}` +
				(relink
					? `, agent_session_id ${session.agentSessionId ?? "null"} -> ${newest.id}`
					: ", agent_session_id unchanged"),
		);
	}
}

main().then(
	() => process.exit(0),
	(err) => {
		console.error(err);
		process.exit(1);
	},
);
