#!/bin/sh
set -e

# The container starts as root only to fix up ownership of the /data volume
# (a named volume from a prior image version, or a fresh bind mount, may not
# be owned by the unprivileged `node` user yet) before dropping privileges.
# Claude Code's bypassPermissions mode (ADR-0003/0010) refuses to run as
# root, so the actual server process must not run as root.
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
	chown -R node:node "${DILNA_DATA_DIR:-/data}"
	exec gosu node "$0" "$@"
fi

exec "$@"
