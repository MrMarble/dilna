# Host-pass-through for git and opencode credentials/config at MVP

## Context

dilna needs two external sets of credentials to function: git access (to clone private repos and to let the agent push/pull inside worktrees) and LLM provider access (opencode reads its own config + auth from `~/.config/opencode/`). For local development the host already has both: `~/.ssh` for git and `opencode auth login` once for the LLM. For docker, both need to be mounted into the container.

## Decision

dilna does **not** own credentials or write opencode config at MVP. It inherits whatever the host environment provides:

- **Git auth:** `~/.ssh` (or whatever git's default credential discovery finds). dilna shells out to `git clone --bare <url> <path>` and it works because the host has SSH configured. No PAT field in the clone modal; no DB-stored tokens.
- **Opencode auth/config:** `~/.config/opencode/` and any provider API keys in the env dilna was launched with. Each spawned `opencode serve` inherits that env + reads that config. dilna never writes a per-worktree `opencode.json`. No model/agent picker in the New Session modal — opencode's global defaults apply.
- **Opencode binary:** dilna shells out to the `opencode` binary already on the host's `PATH`. No bundled binary, no version pinning by dilna (the user's `mise.toml` / package manager handles it).

Docker-specific management (mounting `~/.ssh`, mounting or baking `~/.config/opencode/`, `known_hosts` population) is deferred until the docker-image workstream. Local development works because the host has all of this already.

## Why pass-through (and not own it in the UI)

- **MVP user is the operator:** single-tenant, the user already has SSH keys and has run `opencode auth` once. Re-entering these via dilna's UI is duplicate work for no benefit.
- **UI-managed secrets are a real feature but a heavyweight one:** encrypted-at-rest storage, rotation, per-repo scoping, multi-user ACLs — all of which matter for multi-tenant but are pure overhead at MVP.
- **Consistent model:** both git and opencode follow the same pattern (host-provided, dilna inherits). One mental model, one defer-until-docker note.

## Consequences

- Local dev requires the host to have `opencode` on `PATH`, SSH keys where git expects them, and `opencode auth` configured. Documented in the README, not auto-managed.
- The clone modal is one field: Git URL. Assume SSH (`git@github.com:...`); HTTPS public clone also works with no auth.
- The docker image, when built, will need to mount `~/.ssh` (read-only) and `~/.config/opencode/` (read-write for auth.db refresh), plus a populated `known_hosts` for popular forges. That work is deferred to the docker workstream; not blocking MVP locally.
- Adding a "manage credentials / opencode config" UI later is additive — dilna can write to `~/.ssh` and `~/.config/opencode/` itself once we decide to own that. No data-model migration needed.
- No per-worktree `opencode.json` means all sessions share opencode's global agent/model/tool config for MVP. Per-session model selection, allowed-tools overrides, MCP server registration — all deferred. The user edits global opencode config manually or accepts defaults.