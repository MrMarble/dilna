# syntax=docker/dockerfile:1

# --- build stage -------------------------------------------------------
FROM node:24-bookworm-slim AS build
# pnpm refuses to prune node_modules without a TTY unless CI=true.
ENV CI=true

# python3/make/g++ are a fallback for native modules (better-sqlite3) that
# lack a prebuilt binary for this exact node/arch combo.
RUN apt-get update && apt-get install -y --no-install-recommends \
		python3 make g++ \
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
# ca-certificates: TLS for git https:// clones, outbound API calls, and the
# sandlock download below.
RUN apt-get update && apt-get install -y --no-install-recommends \
		git openssh-client ca-certificates curl \
	&& rm -rf /var/lib/apt/lists/* \
	&& mkdir -p /etc/ssh \
	&& ssh-keyscan -t rsa,ecdsa,ed25519 github.com gitlab.com bitbucket.org \
		>> /etc/ssh/ssh_known_hosts 2>/dev/null

# sandlock sandboxes each spawned agent process to its worktree (ADR-0010).
# Not packaged for Debian, so fetch the prebuilt release binary directly —
# runs unprivileged in this container with just SYS_PTRACE (see
# docker-compose.yml / k8s securityContext.capabilities), unlike bubblewrap
# (the first implementation), which needed CAP_SYS_ADMIN plus disabling
# both seccomp and AppArmor entirely.
ARG SANDLOCK_VERSION=0.8.4
RUN curl -fsSL "https://github.com/multikernel/sandlock/releases/download/v${SANDLOCK_VERSION}/sandlock-x86_64-unknown-linux-gnu.tar.gz" \
		-o /tmp/sandlock.tar.gz \
	&& tar -xzf /tmp/sandlock.tar.gz -C /usr/local/bin ./sandlock \
	&& chmod +x /usr/local/bin/sandlock \
	&& rm /tmp/sandlock.tar.gz

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
# pnpm gives each workspace package its own node_modules of symlinks into
# the root .pnpm store — the root node_modules alone isn't enough for
# Node's resolver to find apps/server's own dependencies.
COPY --from=build /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/apps/server/drizzle ./apps/server/drizzle
COPY --from=build /app/apps/web/dist ./apps/web/dist

ENV PORT=3001
ENV DILNA_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 3001

CMD ["node", "apps/server/dist/index.js"]
