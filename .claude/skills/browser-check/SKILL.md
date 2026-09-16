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

Chromium's shared libraries and fonts are in the runtime image, but the
browser binary is **not** — it's fetched on demand (ADR-0037).

Check before downloading anything; it's shared across sessions on the
persistent `/data` volume, so it's usually already there:

```bash
ls "$XDG_CACHE_HOME/ms-playwright"
```

If `chromium.launch()` reports a missing executable, install it once:

```bash
pnpm --filter @dilna/web exec playwright install chromium --only-shell
```

`--only-shell` gets the headless shell (~267MB) instead of the full browser
(~656MB) — and headless `chromium.launch()` uses the shell anyway, so it's
the right default here. Drop the flag only if you need a headed browser.

Never use `--with-deps`: it shells out to apt, which needs root you don't
have. Never use a bare `install` either — it adds Firefox and WebKit, whose
system libraries aren't in the image.

If `chromium.launch()` fails to spawn its zygote process, the deployment's
seccomp profile is blocking the nested user namespace Chromium's own sandbox
needs. Pass `--no-sandbox`:

```js
chromium.launch({ args: ["--no-sandbox"] })
```

That's safe here — the outer bwrap sandbox, not Chromium's, is the real
isolation boundary (ADR-0010).
