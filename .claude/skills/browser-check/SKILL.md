---
name: browser-check
description: Load a URL (local dev server or a given production URL) in headless Chromium via Playwright, report status/title/console errors, and optionally screenshot it. Use for UI feedback during dilna web development, not for writing test suites.
---

# Checking a page with Playwright

`@playwright/test` is installed in `apps/web` (Chromium only). No MCP server — drive it directly.

Quick check, any URL (dev server or one the user gives you, including production):

```bash
pnpm --filter @dilna/web run check <url> [screenshot-path]
```

Exits non-zero on navigation failure, a console error, a page error, or a failed request — read stdout for details. This wraps `apps/web/scripts/check-page.mjs`; edit that file directly for one-off needs (different viewport, wait for a specific selector, click through a flow) rather than adding flags to the script.

For anything beyond a single-page load/screenshot (multi-step interaction, asserting specific DOM state), write a throwaway script using the same `chromium.launch()` pattern and run it with `node` — don't grow `check-page.mjs` into a general-purpose framework.

For local dev, start the server first (`pnpm dev` from repo root, or the isolated-instance pattern in the `verify` skill if you need a clean DB).

## Inside the dilna container

Chromium and its shared libraries are baked into the runtime image, and
`PLAYWRIGHT_BROWSERS_PATH` points at the pre-installed copy under
`/usr/local/share/ms-playwright` (ADR-0037). You still need the Playwright
*driver* in the worktree you're working in — that comes from that repo's own
`pnpm install`; don't run `playwright install`, which would re-download a
browser onto the `/data` volume for no reason.

If `chromium.launch()` fails to spawn its zygote process, the deployment's
seccomp profile is blocking the nested user namespace Chromium's own sandbox
needs. Pass `--no-sandbox`:

```js
chromium.launch({ args: ["--no-sandbox"] })
```

That's safe here — the outer bwrap sandbox, not Chromium's, is the real
isolation boundary (ADR-0010).
