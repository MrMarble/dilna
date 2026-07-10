# syntax=docker/dockerfile:1

# --- build stage -------------------------------------------------------
FROM node:24-bookworm-slim AS build
# pnpm refuses to prune node_modules without a TTY unless CI=true.
ENV CI=true

# python3/make/g++ are a fallback for native modules (better-sqlite3) that
# lack a prebuilt binary for this exact node/arch combo.
# git: build-info.ts shells out to it to bake the app version/commit hash/
# commit date into the web bundle (see apps/web/vite.config.ts). Needs the
# .git dir to actually be present in the build context too (see
# .dockerignore — it is not excluded, unlike most other dev-only paths).
RUN apt-get update && apt-get install -y --no-install-recommends \
		python3 make g++ git \
	&& rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.10.0 --activate

WORKDIR /app

# Copy manifests first so `pnpm install` is cached unless a package.json or
# the lockfile actually changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build
# Drop devDependencies now that dist/ is built, so only what apps/server
# actually imports at runtime gets copied into the runtime stage.
RUN pnpm install --prod --frozen-lockfile

# --- runtime stage -------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# git + openssh-client: cloning repos (ADR-0005 host-passthrough — the
# container inherits whatever ~/.ssh the operator mounts in).
# ca-certificates: TLS for git https:// clones and outbound API calls.
# bubblewrap + socat: Claude Code's own built-in sandbox (ADR-0010) — bwrap
# does the per-Bash-command filesystem/process isolation, socat relays its
# network proxy. Both are invoked by the `claude` CLI itself, per command,
# not by dilna directly.
# gosu: lets docker-entrypoint.sh start as root (to chown /data), then drop
# to the unprivileged `node` user (uid 1000, baked into the base image)
# before exec'ing node, without losing PID 1 signal handling the way `su`
# would. Claude Code's bypassPermissions mode (ADR-0003/0010) refuses to run
# as root for safety, so the server (which spawns it) can't run as root.
RUN apt-get update && apt-get install -y --no-install-recommends \
		git openssh-client ca-certificates bubblewrap socat gosu \
	&& rm -rf /var/lib/apt/lists/* \
	&& mkdir -p /etc/ssh \
	&& ssh-keyscan -t rsa,ecdsa,ed25519 github.com gitlab.com bitbucket.org \
		>> /etc/ssh/ssh_known_hosts 2>/dev/null

WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=node:node /app/apps/server/dist ./apps/server/dist
# pnpm gives each workspace package its own node_modules of symlinks into
# the root .pnpm store — the root node_modules alone isn't enough for
# Node's resolver to find apps/server's own dependencies.
COPY --from=build --chown=node:node /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build --chown=node:node /app/apps/server/drizzle ./apps/server/drizzle
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV PORT=3001
ENV DILNA_DATA_DIR=/data
ENV HOME=/home/node
# Tells the Claude backend's sandbox setup (ADR-0010) that an outer container
# already provides process/mount isolation, so bwrap can run in its weaker
# nested mode (bind-mounting the container's existing /proc instead of
# mounting a fresh one, which an unprivileged container blocks).
ENV DILNA_CONTAINERIZED=true
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 3001

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "apps/server/dist/index.js"]
