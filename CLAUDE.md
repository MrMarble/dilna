# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Read `CONTEXT.md` first — it defines the domain vocabulary (Repo, Worktree, Session, Agent) used throughout code, commits, and ADRs. Use those terms; avoid synonyms like "conversation", "checkout", or "model".

Every non-obvious design decision has an ADR in `docs/adr/` (agent adapters, session lifecycle, persistence, event/message shape, credentials). Before changing agent lifecycle, persistence, or the event/message contract, check whether it's already been decided there — each ADR has a "why not the alternative" section.

## Commands (run from repo root)

- `pnpm dev` — all dev servers in parallel (server on :3001, web on :5174, web proxies `/api` to the server)
- `pnpm typecheck` / `pnpm test` / `pnpm lint` / `pnpm format`
- Single package: `pnpm --filter @dilna/server run <script>` (or `--filter ./apps/web`)
- Single test file: `pnpm vitest run path/to/file.test.ts`; `apps/server/src/{sessions,repos}/*.test.ts` and `apps/web/src/components/*.test.tsx` are the existing ones
- DB schema changes: edit `apps/server/src/db/schema.ts`, then `pnpm --filter @dilna/server run db:generate` (drizzle-kit) and `db:migrate`

## Architecture

`packages/shared` defines the contract between server and web (`AgentStreamEvent`, `Message`/`MessagePart`, `Session`/`SessionView`) — both sides import from it, never redefine these shapes locally.

`apps/server/src/agents/` holds one file per `Agent` backend — today that's a single file, `pi.ts`, built on `pi-agent-core`'s bare `Agent` class (see ADR-0020 for the go decision to replace the prior `claude.ts`/Claude-Agent-SDK backend with it, and ADR-0011 for why dilna standardizes on one backend file rather than a `handle.kind` union of several — `sessions/manager.ts` dispatches to it directly). Adding a second backend means a new adapter file plus a new dispatch branch in `manager.ts` — not a new abstraction layer (see ADR-0002/0007 for why). The adapter normalizes its backend's native event/transcript shape into the shared `AgentStreamEvent`/`Message` types itself; read `pi.ts`'s own comments before touching it — they document backend-specific quirks (worktree confinement via a `beforeToolCall` hook, the pi-side persistence bridge) that aren't repeated here.

`SessionManager` (`apps/server/src/sessions/manager.ts`) owns the full session lifecycle: worktree creation via `git worktree add`, spawning/resuming the agent process, idle-timeout kill, and persisting agent-native messages into dilna's own SQLite tables after each turn (the DB is the source of truth for history; live agent processes are disposable). The SSE stream in `routes/stream.ts` and `ChatShell.tsx`'s `live` state are a rendering optimization on top of that, not a second source of truth.

`data/` at repo root is real local dev state (cloned repos, worktrees, sqlite db) — gitignored, not a fixture. When testing an agent session end-to-end, don't point it at this directory; run an isolated instance instead (`DILNA_DATA_DIR=<scratch-dir> PORT=<free-port> pnpm --filter @dilna/server run dev`, then `DILNA_API_URL=http://localhost:<port>` for a matching web instance). Check `lsof -i :<port>` before assuming a port is free — a dev server may already be running and hitting it by accident will mutate the user's real data.

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues on `MrMarble/dilna`, via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Multi-context: a root `CONTEXT-MAP.md` will point at per-context `CONTEXT.md` files (e.g. under `apps/server`, `apps/web`, `packages/shared`) as they get created; until then the existing root `CONTEXT.md` remains the single source. See `docs/agents/domain.md`.
