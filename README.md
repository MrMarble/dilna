# dilna

[![Docker build & publish](https://github.com/mrmarble/dilna/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/mrmarble/dilna/actions/workflows/docker-publish.yml)
[![Node](https://img.shields.io/badge/node-24.18.0-339933?logo=node.js&logoColor=white)](mise.toml)
[![Latest tag](https://img.shields.io/github/v/tag/mrmarble/dilna?label=version&color=blue)](https://github.com/mrmarble/dilna/tags)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Your coding agents, running on a server, not your laptop.**

dilna is a self-hosted, web-based workspace for running AI coding agents against locally-cloned repositories. Kick off a session from your phone, close the laptop, and the agent keeps working — because it never lived there in the first place.

> *dilna* is Czech for "workshop" — a place where the work happens whether or not you're standing in it.

> ⚠️ **Fully vibecoded.** This project is built almost entirely by AI agents (fittingly, using dilna itself). Expect rough edges, and review before running it against anything you care about.

## Why

Coding agents are great until you close the lid. dilna moves the agent, the worktree, and the chat onto a server you control, so work continues whether or not your machine is on.

- 🖥️ **Server-side agents** — powered by pi-ai/pi-agent-core, running against real git worktrees
- 🌿 **One worktree per session** — parallel sessions, parallel branches, zero collisions
- 💬 **Resumable chat** — pick up any session from any browser, any time
- 🔒 **Self-hosted** — your repos, your data, your infra

## Quick start

```bash
docker compose up
```

Set `DILNA_PROVIDER` and `DILNA_MODEL` (one global choice for the whole instance — valid providers are `anthropic`, `deepseek`, `moonshotai`, `zai`) plus the matching API key (`ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, or `ZAI_API_KEY`) in your environment or a `.env` file, mount your SSH keys, and you're driving agents from a browser tab. Set `GH_TOKEN` too if you want agents to open PRs or read/comment on issues via the `gh` CLI — generate one with `gh auth login` then `gh auth token` on a machine where you already have `gh` set up, or create a classic PAT at https://github.com/settings/tokens with `repo` scope (add `workflow` if agents need to edit workflow files, `read:org` for org-owned repos).

## Local development

```bash
mise install       # node 24.18.0, pnpm 11.10.0
cp .env.example .env   # fill in DILNA_PROVIDER/DILNA_MODEL + the matching API key
pnpm install
pnpm dev
```

mise loads `.env` automatically (see `mise.toml`'s `_.file` directive) into every command it runs in this repo, so the tokens persist across `pnpm dev`/`pnpm test` invocations without re-exporting them each session.

- `apps/server` — Hono API + the agent runtime
- `apps/web` — the chat UI
- `packages/shared` — types shared across both

See `docs/adr` for the architecture decisions behind it, and `CONTEXT.md` for the vocabulary this codebase uses (Repo, Worktree, Session, Agent).
