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
# curl: fetches the mise install script below (the runtime stage installs
# its own curl too, for sessions — see below — but copies this stage's
# already-downloaded mise binary rather than re-running the installer).
# ca-certificates: unlike pnpm/npm (Node's TLS stack bundles its own root
# CA store), curl relies on the system's — and node:*-bookworm-slim, unlike
# the non-slim variants, ships without it. Without this, curl fails
# immediately with exit 77 ("problem with reading the SSL CA cert") on its
# very first HTTPS request below.
RUN apt-get update && apt-get install -y --no-install-recommends \
		python3 make g++ git curl ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@11.10.0 --activate

# mise (ADR-0012): gives sessions a per-user way to install whatever
# language/tool version the repo they're working on actually needs (node,
# go, python, ...) without root — dilna's own baked node/pnpm above is only
# for building dilna itself, not for the arbitrary repos agents are pointed
# at. A single static binary, so the runtime stage just copies it rather
# than re-running the installer.
# Pinned (like node/pnpm above) for reproducible builds rather than
# whatever's newest the day the image happens to be built.
# Downloaded to a file and executed as a separate step, not piped straight
# into `sh` (`curl ... | sh`): Docker's default RUN shell is `sh -c`, which
# has no `pipefail` — if curl fails (network blip, proxy, whatever) mid-pipe,
# `sh` still gets run with empty stdin, does nothing, and exits 0, so the
# failure only ever surfaces later as a baffling "not found" on the COPY
# below in the runtime stage, in a different layer entirely. `&&`-chaining
# the download makes curl's own exit code fail the build immediately, and
# the trailing `test -x` is a belt-and-suspenders check that the installer
# actually produced a binary before this stage is considered done.
ARG MISE_VERSION=2026.7.5
RUN curl -fsSL https://mise.run -o /tmp/mise-install.sh \
	&& MISE_VERSION="v${MISE_VERSION}" MISE_INSTALL_PATH=/usr/local/bin/mise \
		sh /tmp/mise-install.sh \
	&& rm -f /tmp/mise-install.sh \
	&& test -x /usr/local/bin/mise

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
# curl: general-purpose fetch for whatever a session's Bash tool needs
# (hitting its own dev server, GitHub/GitLab APIs, one-off scripts) — also
# what mise's asdf/vfox-compatible plugins shell out to for the long tail of
# tools beyond its Rust-native core backends (node/go/python/...), which
# fetch without it (ADR-0012).
# unzip + xz-utils: mise's own core backends extract archives internally,
# but asdf-style plugin install scripts commonly unpack a `.zip` or `.tar.xz`
# release asset themselves via these system binaries.
# jq: the de facto way a Bash-tool command parses JSON output (package.json,
# `gh`/REST API responses, lockfiles) without reaching for a scripting
# language just to pluck a field.
# procps + lsof: a session iterating on a repo commonly starts a dev
# server/watcher in the background; these are what let it find and kill
# what's holding a port or PID rather than getting stuck on "address already
# in use".
# libatomic1: the mise-installed pnpm binary (aqua registry, ADR-0012) is
# linked against it and fails outright at startup without it —
# "error while loading shared libraries: libatomic.so.1: cannot open shared
# object file" — since node:*-bookworm-slim doesn't ship it and there's no
# root/sudo at runtime for a session to install it itself.
RUN apt-get update && apt-get install -y --no-install-recommends \
		git openssh-client ca-certificates bubblewrap socat gosu \
		curl unzip xz-utils jq procps lsof libatomic1 \
	&& rm -rf /var/lib/apt/lists/* \
	&& mkdir -p /etc/ssh \
	&& ssh-keyscan -t rsa,ecdsa,ed25519 github.com gitlab.com bitbucket.org \
		>> /etc/ssh/ssh_known_hosts 2>/dev/null

# gh (GitHub CLI, ADR-0013): lets sessions open PRs, read/comment on issues,
# etc. against whatever repo they're pointed at. Installed from GitHub's own
# apt repo rather than Debian bookworm's package — the Debian build lags and
# was flagged by GitHub for depending on deprecated API behavior. Auth is a
# straight extension of ADR-0005's host-passthrough model (same shape as
# CLAUDE_CODE_OAUTH_TOKEN/ANTHROPIC_API_KEY): gh reads GH_TOKEN directly from
# the process environment on every invocation, with no `gh auth login` and
# nothing persisted to disk beforehand — setting GH_TOKEN in
# docker-compose.yml is the entire auth story, since claude.ts already
# spreads process.env into every session's subprocess env.
RUN mkdir -p -m 755 /etc/apt/keyrings \
	&& curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
		-o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
		> /etc/apt/sources.list.d/github-cli.list \
	&& apt-get update && apt-get install -y --no-install-recommends gh \
	&& rm -rf /var/lib/apt/lists/*

# mise (ADR-0012): the static binary built in the build stage, copied rather
# than re-running the installer here. Compiling a language from source (e.g.
# mise's core `python` backend) still has no toolchain at runtime —
# python3/make/g++ above are build-stage-only, a known follow-up if
# requested.
COPY --from=build /usr/local/bin/mise /usr/local/bin/mise

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

# mise (ADR-0012): shims dir first on PATH so `node`/`go`/`python`/etc.
# resolve to whatever version a session has installed for its own worktree,
# ahead of the node/pnpm baked in for building dilna itself. mise's default
# data/state/cache/config dirs (all under $HOME) are pre-created here so the
# native Bash sandbox (see apps/server/src/agents/claude.ts) has a concrete,
# already-`node`-owned path to grant `filesystem.allowWrite` on — everything
# under $HOME is otherwise outside the worktree the sandbox confines writes
# to. Same reasoning for /home/node/.local/share/pnpm: pnpm's default store
# location resolves to the DILNA_DATA_DIR volume root, outside the worktree
# the sandbox confines writes to, so claude.ts redirects it here instead via
# `npm_config_store_dir` (see PNPM_STORE_DIR's doc comment) — pre-created for
# the same "already node-owned" reason as the mise dirs above.
ENV PATH="/home/node/.local/share/mise/shims:${PATH}"
RUN mkdir -p \
		/home/node/.local/share/mise \
		/home/node/.local/state/mise \
		/home/node/.cache/mise \
		/home/node/.config/mise \
		/home/node/.local/share/pnpm \
	&& chown -R node:node /home/node/.local /home/node/.cache /home/node/.config
EXPOSE 3001

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "apps/server/dist/index.js"]
