#!/bin/sh
set -e

# The container starts as root only to fix up ownership of the /data volume
# (a named volume from a prior image version, or a fresh bind mount, may not
# be owned by the unprivileged `node` user yet) before dropping privileges.
# bwrap's unprivileged-user-namespace sandboxing model (ADR-0010, driven by
# `apps/server/src/agents/pi.ts` via `@anthropic-ai/sandbox-runtime`) assumes
# a non-root caller, so the actual server process must not run as root.
if [ "$(id -u)" = "0" ]; then
	# Let operators align the container user with their host UID/GID (e.g.
	# so a bind-mounted ~/.ssh with tight key permissions stays readable)
	# without needing a custom image. Defaults match the `node` user
	# (uid 1000) baked into the base image.
	PUID="${PUID:-1000}"
	PGID="${PGID:-1000}"
	if [ "$PUID" != "1000" ] || [ "$PGID" != "1000" ]; then
		groupmod -o -g "$PGID" node
		usermod -o -u "$PUID" node
	fi
	# Skip the recursive chown once ownership is already correct — with many
	# cloned repos/worktrees under /data, walking the whole tree on every
	# container start/restart gets slow and delays boot for no reason once
	# it's already been fixed up.
	data_dir="${DILNA_DATA_DIR:-/data}"
	if [ "$(stat -c %u "$data_dir")" != "$PUID" ] || [ "$(stat -c %g "$data_dir")" != "$PGID" ]; then
		chown -R node:node "$data_dir"
	fi
	exec gosu node "$0" "$@"
fi

# pi-coding-agent's grep/find tools self-download rg/fd into
# `getBinDir()` (`~/.pi/agent/bin` by default) the first time neither is on
# PATH, and cache that resolved directory as a module-level constant at
# import time — so it must be a real process env var before `node` starts,
# not something apps/server/src/agents/pi.ts can inject later (its
# `toolchainEnv()` only reaches the sandboxed bash tool's *own* subprocess,
# a different process from the server itself, which is what actually runs
# grep/find). Rooted under DILNA_DATA_DIR, not $HOME, for the same reason as
# mise/pnpm/gh above (ADR-0012, issue #83): $HOME doesn't survive a pod
# restart. In practice rg/fd are already apt-installed system packages (see
# Dockerfile), so this path is rarely exercised — this just closes the gap
# instead of relying on that as an accident of the current image.
export PI_CODING_AGENT_DIR="${DILNA_DATA_DIR:-/data}/toolchain-home/pi-agent"

# git commit identity: derive from the authenticated gh account (ADR-0013)
# instead of asking the operator for a redundant user/email — GH_TOKEN is
# already required for gh to work at all, and nothing else sets a git
# identity here (only ~/.ssh is host-mounted, not ~/.gitconfig, per
# ADR-0005). Written once per container start into the shared $HOME, not
# per-session, since every session already shares one GH_TOKEN/gh identity.
# Best-effort: skipped (not fatal) if GH_TOKEN is unset, the API call fails,
# or user.email is already set (e.g. an operator-mounted .gitconfig).
if [ -n "$GH_TOKEN" ] && ! git config --global user.email >/dev/null 2>&1; then
	gh_user_json="$(gh api user 2>/dev/null)" || gh_user_json=""
	if [ -n "$gh_user_json" ]; then
		gh_login="$(echo "$gh_user_json" | jq -r '.login')"
		gh_id="$(echo "$gh_user_json" | jq -r '.id')"
		gh_name="$(echo "$gh_user_json" | jq -r '.name // .login')"
		git config --global user.name "$gh_name"
		git config --global user.email "${gh_id}+${gh_login}@users.noreply.github.com"
	fi
fi

exec "$@"
