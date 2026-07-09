---
name: verify
description: Drive an isolated dilna instance end-to-end (server + web) to verify a change against the real HTTP/SSE surface and the sidebar UI.
---

# Verifying dilna changes end-to-end

Never point a test session at `data/` or the default data dir — that's real state (see CLAUDE.md). Run an isolated instance:

```bash
S=$(mktemp -d)   # or the session scratchpad
mkdir -p $S/data $S/fixture
git -C $S/fixture init -qb main . && git -C $S/fixture commit -qm init --allow-empty
DILNA_DATA_DIR=$S/data PORT=4517 pnpm --filter @dilna/server run dev   # background
curl -sf http://localhost:4517/api/health                              # poll until up
```

Drive the API surface:

```bash
curl -s -X POST :4517/api/repos -d '{"url":"<fixture path>"}'      # clone → repo.id
curl -s -X POST :4517/api/sessions -d '{"repoId":"..."}'           # → session.id
curl -s -X POST :4517/api/sessions/:id/messages -d '{"text":"..."}'  # 202, async turn
curl -s :4517/api/sessions/:id/messages                            # poll for assistant reply
timeout 2 curl -sN :4517/api/stream                                # SSE connect snapshot
```

All POST bodies need `-H 'content-type: application/json'`. A trivial prompt ("Reply with the single word: ok") completes a real agent turn in a few seconds and exercises the full post-turn pipeline (persistence, title sync, rate-limit pull).

For the web UI, run vite against the isolated API and screenshot with Playwright MCP:

```bash
DILNA_API_URL=http://localhost:4517 pnpm --filter ./apps/web run dev
```

Gotchas:

- `pnpm --filter ./apps/web run dev -- --port N` does NOT pass the flag through (vite receives a literal `--`); vite auto-picks the next free port after 5174 — read the log for the actual port.
- To stop the isolated server use `kill $(lsof -ti tcp:4517 -sTCP:LISTEN)`. A bare `lsof -ti :4517` also lists the vite proxy's client connection and kills the web server with it.
- The DB is at `$DILNA_DATA_DIR/db/dilna.sqlite`; safe to poke with sqlite3/python between server restarts to set up state (e.g. expiring `rate_limits.resets_at` to probe staleness).
- Sending a message runs a real agent turn against the host's Claude credentials — keep prompts tiny.
