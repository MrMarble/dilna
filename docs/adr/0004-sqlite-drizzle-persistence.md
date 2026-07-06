# SQLite (better-sqlite3) via Drizzle ORM for metadata + normalized message history

## Context

dilna needs to persist its own metadata: repos, sessions, worktree bindings, foreign refs to the agent backend's own session IDs, and a cached copy of chat message history so the UI keeps working after the agent process is killed (per the agent lifecycle in ADR-0003). Multi-backend support (ADR-0002) requires stored messages to be normalized to dilna's internal event union, not stored as backend-native blobs.

## Decision

Use SQLite via `better-sqlite3` with Drizzle ORM for typed schema + migrations. One database file at `$DILNA_DATA_DIR/db/dilna.sqlite`. Migrations auto-run on boot.

Schema ships with: `repos`, `sessions`, `messages` tables. The `sessions` table carries `agentType` (default `'opencode'`) and `agentSessionId` (foreign ref to the agent backend's own session id) per ADR-0002. The `messages` table stores each message's normalized content as `content_json` — never raw opencode/claude events.

## Why SQLite + better-sqlite3 (and not the alternatives)

- **Postgres rejected for MVP:** single-tenant data is small (hundreds of sessions, a few repos). Running a postgres container sidecar in the docker image is ops cost with no payoff. Drizzle supports both SQLite and Postgres with the same schema, so flipping later is a driver-import change + migration, not a rewrite.
- **Flat files (JSON) rejected:** the UI needs "list sessions for repo X ordered by lastActiveAt" and similar query patterns. Reimplementing queries against flat files is worse than just using SQLite.
- **better-sqlite3 specifically (not node:sqlite or sqlite3):** synchronous API = no callback/promise noise, simpler code, fastest for read-heavy single-process use. Node 24 ships a built-in `node:sqlite` but Drizzle's better-sqlite3 driver is more battle-tested; revisit when node:sqlite stabilizes.

## Consequences

- One sqlite file lives next to repos in `$DILNA_DATA_DIR`. Backups = copy the directory.
- Auto-migrate on boot means a schema bump ships in the docker image and applies on container restart. Good for single-tenant; would need a real migration runner for multi-tenant SaaS.
- `content_json` is a denormalized column — adapters normalize on write and on resume, never on read. UI consumes normalized events directly.
- If sqlite ever hits a wall (concurrent writers, scale), migrating to Postgres is one Drizzle driver swap plus a data migration script. Not free, but bounded.