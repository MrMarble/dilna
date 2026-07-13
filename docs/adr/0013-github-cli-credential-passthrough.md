# GitHub CLI (`gh`) via GH_TOKEN host-passthrough

## Context

ADR-0012 deliberately left `gh` out of the runtime image: "useful for
PR/issue workflows, but has no credential story yet — ADR-0005's
host-passthrough only covers git SSH and the Claude token, not a `gh auth`
flow. Adding it without auth wired up would just be a binary that fails on
first use." Sessions can already `git push` a branch (SSH passthrough,
ADR-0005) but have no way to open the PR, read an issue, or comment on one —
`gh` closes that gap, but ADR-0012 correctly deferred it until auth was
actually worked out.

## Decision

Install `gh` in the runtime image and authenticate it the same way as every
other credential in this project — host-passthrough, not UI-managed
(ADR-0005/0009):

- **Binary**: installed from GitHub's own apt repo (keyring + source list),
  not Debian bookworm's package — the Debian build lags upstream and was
  flagged by GitHub for depending on deprecated API behavior. Same
  reasoning as mise being fetched from its own installer rather than a
  distro package (ADR-0012).
- **Auth**: `gh` reads the `GH_TOKEN` (or `GITHUB_TOKEN`) env var directly on
  every invocation — no `gh auth login`, no `~/.config/gh/hosts.yml` to
  populate, no host mount at all. `docker-compose.yml` adds
  `GH_TOKEN=${GH_TOKEN:-}` alongside `CLAUDE_CODE_OAUTH_TOKEN`/
  `ANTHROPIC_API_KEY`, and `claude.ts` already spreads `process.env` into
  every session's subprocess env (for `MISE_TRUSTED_CONFIG_PATHS`, ADR-0012)
  — so no code change was needed to make `GH_TOKEN` reach a session's Bash
  tool. This is a strictly simpler credential than git SSH or the Claude
  token: nothing to mount read-only, nothing pre-populated (no
  `known_hosts`-style bootstrap needed since it's a plain HTTPS API token).
- **Sandbox** (ADR-0010): `gh`'s outbound calls to `api.github.com` are
  already covered by the existing `network.allowedDomains: ["*"]`. Even
  though `GH_TOKEN` auth needs no config file, `gh` may still write a small
  config/cache under `$HOME` on first run (default `config.yml`, extension
  list cache) — `claude.ts` grants `~/.config/gh` and `~/.cache/gh` to
  `filesystem.allowWrite` defensively, same reasoning as the existing
  `MISE_WRITABLE_PATHS` grant.

## Why not the alternatives

- **`gh auth login` with a mounted `~/.config/gh`**: works, but needs an
  interactive device-code flow the first time — nothing in dilna's headless
  session model can answer that prompt. A token env var needs no login step
  at all.
- **UI-managed credentials (a token field in dilna's own DB)**: exactly what
  ADR-0005 already rejected for git and the Claude token, for the same
  reason — heavyweight (encryption at rest, rotation, per-repo scoping) for
  a single-tenant, self-hosted, operator-trusted tool.
- **Per-repo or per-session tokens**: would need dilna to own credential
  storage and a UI to manage it, the same rejected heavyweight feature above.
  One container-level `GH_TOKEN` matches the existing model where the SSH
  key and Claude token are also shared across every session.

## Consequences

- Operators who want PR/issue workflows from agents generate one PAT
  (`repo` scope; `workflow` if sessions edit workflow files; `read:org` for
  org-owned repos) and set `GH_TOKEN` — no other setup.
- Same blast radius as the existing SSH key and Claude token: one token,
  trusted to every session/repo dilna manages. Not a new trust boundary,
  just an additional credential at the same trust level ADR-0009 already
  accepted ("a self-hosted instance handed a git SSH key, opencode session,
  and Claude token is still trusted to whoever can reach its port").
- If `GH_TOKEN` is unset, `gh` is present but fails on first use with an
  auth error — no different from any other unset optional credential in
  this project (e.g. `ANTHROPIC_API_KEY` without `CLAUDE_CODE_OAUTH_TOKEN`).
- Adding a UI-managed credentials feature later is additive, same note
  ADR-0005/0009 already make for git/Claude.
