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

- 🖥️ **Server-side agents** — powered by the Claude Agent SDK, running against real git worktrees
- 🌿 **One worktree per session** — parallel sessions, parallel branches, zero collisions
- 💬 **Resumable chat** — pick up any session from any browser, any time
- 🔒 **Self-hosted** — your repos, your data, your infra

## Quick start

```bash
docker compose up
```

Set `CLAUDE_CODE_OAUTH_TOKEN` (or `ANTHROPIC_API_KEY`) in your environment or a `.env` file, mount your SSH keys, and you're driving agents from a browser tab.

## Local development

```bash
mise install       # node 24.18.0, pnpm 11.10.0
pnpm install
pnpm dev
```

- `apps/server` — Hono API + the agent runtime
- `apps/web` — the chat UI
- `packages/shared` — types shared across both

See `docs/adr` for the architecture decisions behind it, and `CONTEXT.md` for the vocabulary this codebase uses (Repo, Worktree, Session, Agent).
