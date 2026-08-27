# `Session.agentType` schema migration

Design for wayfinder ticket [Design: Session.agentType schema migration](https://github.com/MrMarble/dilna/issues/99), child of map [#93](https://github.com/MrMarble/dilna/issues/93). Reads `apps/server/src/db/schema.ts`, `packages/shared/src/types.ts`, the actual committed migration `apps/server/drizzle/0001_aromatic_agent_brand.sql` (ADR-0011's own `opencode`→`claude` default change — direct precedent for this exact operation), and the web-side `agentType` consumers (`apps/web/src/lib/agent-icons.tsx`, `ChatHeader.tsx`, `ChatShell.tsx`) to see what's actually live on this field beyond dispatch. Also resolves the `Session.agentSessionId` question [#97](https://github.com/MrMarble/dilna/issues/97) explicitly punted here.

## 1. `agentType`: keep it (option 1), default moves to `"pi"` — not vestigial, the web UI already keys off it

`agentType` is **not** just an internal dispatch discriminant today — despite `SessionManager` having no `handle.kind` branch since ADR-0011, the field is genuinely live in the web app: `apps/web/src/lib/agent-icons.tsx`'s `AgentIcon` picks a brand icon by `agentType === "claude"` (falls back to a generic bot icon otherwise), and `ChatHeader.tsx`/`ChatShell.tsx` render `` `Agent · ${AGENT_LABELS[session.agentType]}` `` per session and per message. **Option 2 (drop the column) would break real, shipped UI code**, not just remove theoretical future-proofing — ruled out on that basis alone.

**Option 1**: keep `agentType`, single-valued, default moves `"claude"` → `"pi"` — exactly ADR-0011's own precedent (it moved the default `"opencode"` → `"claude"` and kept `"openai"` as a reserved, not-yet-implemented value "since it was never built, [it] costs nothing beyond the guard clauses that already throw"). Apply the identical reasoning here: `AgentType` (`packages/shared/src/types.ts`) becomes `"pi" | "openai"` (drops `"claude"` the same way `"opencode"` was dropped, not kept as a dead union member), `DEFAULT_AGENT_TYPE` becomes `"pi"`. `create()`'s existing `agentType === "openai"` guard (manager.ts:519, throws "not implemented yet") is unchanged in shape — it's still the cheap reserved-value pattern ADR-0011 established, now guarding the same not-yet-built value against a `pi`-only live path instead of a `claude`-only one.

**Option 3 (dedicated `provider`/`model` columns) is not decided here — deferred, not rejected.** The ticket asks about recording "what actually ran per session... useful for future display/audit even without a picker UI yet" — but map #93's own **Out of scope** section already defers the picker/display UI entirely ("Provider/model picker UI in `apps/web` — deferred, not part of this migration's destination"). Adding columns purely to feed a display that's explicitly out of scope is exactly the kind of premature sophistication this migration has already decided against elsewhere (the persistence design accepted a known limitation over building a sturdier layer nobody needs yet, per the map's own bare-minimum framing). If an audit/display need becomes real later, it's a small addition on top of an unrelated column (`sessions.provider`/`sessions.model`, or per-message via `AssistantMessage`'s existing `provider`/`model`/`api` fields flowing into `MessagePart`, per #96 §2) — not something this migration needs to design now to avoid foreclosing it later.

## 2. `Session.agentSessionId`: drop it — the one open question #97 left for this ticket

[#97](https://github.com/MrMarble/dilna/issues/97) traced `agentSessionId`'s three current jobs (Claude resume key, Claude transcript-file lookup key, title-auto-sync input) and found none survive for pi (per [#96](https://github.com/MrMarble/dilna/issues/96): resume reconstructs from dilna's own SQLite `Message[]` rows directly, no external id needed at all). It left two options for this ticket: drop the column, or repurpose it for `pi-agent-core`'s `AgentOptions.sessionId` — described in `pi-agent-core/dist/agent.d.ts` as *"Session identifier forwarded to providers for cache-aware backends"*, a provider-side prompt-caching hint, structurally unrelated to what the column means today.

**Drop it.** Repurposing the column would mean storing a second, redundant identifier — `pi.ts` doesn't need to mint or persist a *new* id for `AgentOptions.sessionId`'s cache-affinity role at all: `Session.id` (dilna's own already-stable, already-persisted primary key) can be passed directly as `Agent`'s `sessionId` option when constructing it. A stable identifier is all a cache-affinity hint needs to be useful across a session's turns and across cold-starts (server restart, idle-kill respawn); it doesn't need to match some externally-issued value the way Claude's resumable transcript id did, so there's nothing left for a separate column to hold. `apps/server/src/agents/pi.ts`'s construction code passes `sessionId: session.id` to `new Agent(...)` — no schema change needed to support this, it's just an argument.

## 3. Existing `agentType='claude'`/`agentSessionId`-populated rows: won't crash, explicit rejection at dispatch time

`agent_type` is a plain SQLite `text` column with **no `CHECK` constraint** — confirmed directly from `apps/server/drizzle/0001_aromatic_agent_brand.sql`, the migration that made this exact kind of change once already (moved the column's default from `'opencode'` to `'claude'`; its `INSERT INTO __new_sessions(...) SELECT ... FROM sessions` step copies every existing row's `agent_type` value **verbatim**, not rewritten to the new default — a default only affects future inserts that omit the column). A migration changing this column's default to `'pi'` (§4) will not crash, error, or need a backfill `UPDATE` for the same reason: SQLite doesn't validate `text` column contents against the application-level `AgentType` union at all, so an old `agent_type = 'claude'` row remains a perfectly valid row after migration, its stored value untouched.

What changes is what dilna's *application code* does when it encounters one. Per map #93's Notes ("no migration path... 'claude never existed'") and ADR-0011's own precedent (the `"openai"` guard throws rather than silently reinterpreting), the execution session's `startAgent`/`create()` should **explicitly reject** any `agentType` value other than `"pi"` — including the legacy `"claude"` value on an old row, not just the reserved `"openai"` placeholder — with the same "not implemented"-shaped error, rather than either crashing unpredictably or silently treating it as `"pi"`. A pre-migration session left in the database is inert going forward (can't be resumed), matching "claude never existed" literally: it simply can no longer start.

## 4. Concrete migration plan

`schema.ts` diff:

```diff
 	agentType: text("agent_type").notNull().default("claude"),
+	agentType: text("agent_type").notNull().default("pi"),
-	agentSessionId: text("agent_session_id"),
```

`packages/shared/src/types.ts` diff:

```diff
-export type AgentType = "claude" | "openai";
+export type AgentType = "pi" | "openai";
-export const DEFAULT_AGENT_TYPE: AgentType = "claude";
+export const DEFAULT_AGENT_TYPE: AgentType = "pi";
```

`pnpm --filter @dilna/server run db:generate` output: a **dropped column** forces the same table-rebuild shape SQLite always needs for anything beyond a plain `ADD COLUMN` (SQLite has no `DROP COLUMN`-and-`ALTER DEFAULT`-in-place path drizzle-kit can use directly) — this will look exactly like `0001_aromatic_agent_brand.sql`'s pattern, generated fresh as the next-numbered migration:

```sql
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`worktree_path` text NOT NULL,
	`worktree_dir_name` text NOT NULL,
	`branch_name` text NOT NULL,
	`agent_type` text DEFAULT 'pi' NOT NULL,
	`title` text DEFAULT 'New session' NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`last_active_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("id", "repo_id", "worktree_path", "worktree_dir_name", "branch_name", "agent_type", "title", "status", "input_tokens", "output_tokens", "created_at", "last_active_at")
SELECT "id", "repo_id", "worktree_path", "worktree_dir_name", "branch_name", "agent_type", "title", "status", "input_tokens", "output_tokens", "created_at", "last_active_at" FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
```

(Exact column ordering/formatting is drizzle-kit's to generate — the execution session should run `db:generate` for real rather than hand-writing this — but the shape, the dropped `agent_session_id` column, and the `agent_type` default change are all that's actually deciding here.) `db:migrate` applies it the same way every prior migration has.

## Summary for the execution session

- `agentType`: kept, default → `"pi"`, `AgentType` union → `"pi" | "openai"`. Web-side `agent-icons.tsx`/`AGENT_LABELS` need a `"pi"` branch (currently only branch on `"claude"` vs. fallback) — flagged as a real, needed UI change this migration causes, not optional polish.
- `agentSessionId`: dropped. `pi.ts` passes `session.id` directly as `Agent`'s `sessionId` construction option — no replacement column.
- No backfill needed for existing rows — SQLite's lack of a `CHECK` constraint on this `text` column means old values survive the table-rebuild untouched; `startAgent` rejecting any non-`"pi"` `agentType` (including legacy `"claude"`) is an application-code decision, not a migration-time one.
- `provider`/`model` columns: not added, deferred until the (currently out-of-scope) picker/display UI makes them load-bearing.
