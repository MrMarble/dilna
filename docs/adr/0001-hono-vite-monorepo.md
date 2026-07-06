# Hono backend serving a Vite React SPA, in a pnpm workspace monorepo

## Context

dilna is a single-tenant, self-hosted web app that supervises `opencode server` child processes (one per Session/Worktree), proxies streaming tokens to the browser, and manages git worktrees. The backend is heavy (process supervision, long-lived SSE streams, git operations); the frontend is a conventional chat UI.

## Decision

pnpm workspace monorepo with three packages:

- `apps/server` — Hono on Node 24 (TypeScript). Owns repo/worktree/agent management, REST endpoints for state-changing ops, SSE for streaming. In production it serves the built SPA bundle as static assets so the deployment is a single Docker image.
- `apps/web` — Vite + React + TypeScript + Tailwind v4 + shadcn/ui + lucide-react + motion. Pure client; imports types from `@dilna/shared` only, never from `apps/server`.
- `packages/shared` — TypeScript types (Repo, Session, Worktree, message schemas) shared across server and web.

Vite dev server proxies API/`/sse` to the Hono backend during development; in production the SPA is bundled and served from Hono at the same origin, so the web client uses same-origin paths (no CORS, no env-switched base URL beyond what Vite already handles via its proxy config).

Strict import boundary: `apps/server` never imports from `apps/web`; `apps/web` imports only from `@dilna/shared`.

## Why Hono + Vite (and not the alternatives)

- **Next.js rejected**: the server's job is process supervision + streaming proxy, not SSR/RSC/server-actions. Next's coupling would mean fighting the framework for raw `child_process` and long-lived SSE.
- **Fullstack-Hono (Hono client, Hono JSX) rejected**: dilna's frontend will have a lot of custom components and benefit from the React/Vite ecosystem (shadcn/ui, motion, lucide). Vite + React gives that with no compromise.
- **Two-app deploy (separate static CDN + API service) rejected for MVP**: a single Docker image keeps deploys trivial; we can split later if needed.

## Consequences

- Two build targets (`apps/server`, `apps/web`) but one deploy artifact (Hono serves the web bundle).
- Type sharing requires discipline: cross-package changes go through `packages/shared`.
- For local dev: `pnpm dev` runs both Vite (with API proxy to Hono) and Hono concurrently.