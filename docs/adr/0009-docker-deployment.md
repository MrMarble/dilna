# Docker deployment: single container, host-passthrough credentials extended to the Claude backend

ADR-0005 deferred all Docker-specific credential handling ("mounting `~/.ssh`, mounting or baking `~/.config/opencode/`, `known_hosts` population... deferred until the docker-image workstream"). This ADR is that workstream.

## Decision

One container, one Node process. `apps/server`'s Hono app now also serves `apps/web`'s built static assets (with an SPA fallback to `index.html` for non-`/api` routes) — there is no second nginx/static-file container. The multi-stage `Dockerfile` builds all workspace packages, then copies only the runtime artifacts (`apps/server/dist`, `apps/server/node_modules`, `apps/server/drizzle` migrations, `apps/web/dist`) into a slim `node:24-bookworm-slim` runtime stage — matched to the build stage's OS/libc so native modules (`better-sqlite3`) and the vendored `opencode`/`claude` binaries don't hit a glibc/musl mismatch.

Credentials remain **host-passthrough, not UI-managed** — this ADR extends ADR-0005's pattern (git SSH, opencode config) to also cover the Claude Agent SDK's own auth, rather than building a Settings page or DB-backed secrets store:

- **Git**: `~/.ssh` mounted read-only. `git`, `openssh-client`, and `ca-certificates` are installed in the runtime image; GitHub/GitLab/Bitbucket host keys are baked into `/etc/ssh/ssh_known_hosts` at build time (via `ssh-keyscan`) so SSH clones to those forges don't hang on an unanswerable host-key prompt in a non-interactive container.
- **opencode**: the `opencode` CLI (a separate binary from the `@opencode-ai/sdk` npm client) is installed globally in the image via `npm install -g opencode-ai`. Its config (`~/.config/opencode`, read-only) and its auth/session data (`~/.local/share/opencode`, read-write — opencode writes its own sqlite db and session storage there) are both mounted from the host.
- **Claude Agent SDK**: no new mechanism at all. `query()` resolves credentials from the process environment exactly like the SDK always has; the container just needs `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, for Pro/Max subscribers) or `ANTHROPIC_API_KEY` set as an env var. We explicitly decided against a Settings-page/DB-backed credentials UI for this — see the discussion this ADR follows from.

dilna's own state (cloned repos, worktrees, the sqlite db) lives under `/data`, a declared `VOLUME` — never baked into the image.

## Why not the alternatives

- **Multi-container (separate static-file server + API server)**: more moving parts for a self-hosted single-operator tool with no load-balancing or independent-scaling need. Adding `serveStatic` to the existing Hono app was a handful of lines.
- **UI-managed credentials (a Settings page, DB-stored tokens)**: this is exactly what ADR-0005 already rejected for MVP ("heavyweight... pure overhead") — extending host-passthrough to the Claude token keeps that single mental model intact instead of half-adopting a credentials UI for just one backend.
- **Alpine/musl base image**: `opencode`'s optional-dependency binaries and the Claude Agent SDK's bundled `claude` binary are glibc-linked; Debian-slim avoids a musl-compatibility problem for zero benefit at this trust level (self-hosted, not size-optimized for a CDN pull).

## Consequences

- Fixed two pre-existing bugs surfaced while getting a clean build: `apps/server/tsconfig.json`'s `paths` mapping tripped a TS 6.0 deprecation (`ignoreDeprecations: "6.0"` added to `tsconfig.base.json`), and the root `build` script tried to run a nonexistent `build` script on `@dilna/shared` (which ships as raw TypeScript, inlined by esbuild/vite at each consumer — it was never meant to have its own build step). Both were latent breaks in `pnpm run build`, not Docker-specific.
- Adding a UI-managed credentials feature later is additive, same as ADR-0005 already notes for opencode/git.
- No app-level auth or tool-approval gating is introduced here — a self-hosted instance handed a git SSH key, opencode session, and Claude token is still trusted to whoever can reach its port. That's an explicit, separate deferral, not an oversight of this ADR.
