# Bake headless Chromium and its shared libraries into the runtime image

## Context

`@playwright/test` is already a devDependency of `apps/web`. There is a
`check-page.mjs` script built on it (`chromium.launch()` → `page.goto()` →
`page.screenshot()`), a `browser-check` skill documenting it ("Load a URL …
in headless Chromium via Playwright, report status/title/console errors, and
optionally screenshot it"), and the `verify` skill points at both. The
tooling assumes a working browser.

No session has ever been able to launch one. The runtime image is
`node:24-bookworm-slim`, which ships none of Chromium's runtime shared
libraries, and sessions run as the unprivileged `node` user with no
root/sudo (ADR-0010's non-root requirement for bwrap, restated in ADR-0012:
"the runtime image also has no root-usable system package manager … `apt-get`
needs root"). So a session cannot install them itself, at all, ever. The
gap can only be closed in the image build, where root is available.

The failure was recorded concretely by the Agent Artifact Viewer session
(PR #195): *"No Playwright/screenshots possible (missing `libglib-2.0.so.0`,
needs root) — UI verified by reasoning + vitest/jsdom only."* Verified still
true from inside the deployed image: `ldconfig -p` finds no
`libglib-2.0.so.0`, no `libnss3.so`, no `libcairo.so.2`, no `libgbm.so.1`.

This blocks two things at once: browser-based UI verification (ADR-0032's
artefact viewer renders HTML that nothing can currently screenshot), and a
separately-reported failure of a Cairo-backed image-generation library.

## Decision

Install Chromium's Debian 12 shared-library set, fontconfig, and fonts into
the runtime stage's existing `apt-get` layer, and bake the Chromium binary
itself into the image at a fixed, root-owned path pinned via
`PLAYWRIGHT_BROWSERS_PATH`.

### The library list comes from Playwright, not from guesswork

`libglib-2.0.so.0` is only the first of 21. Rather than hand-assembling the
list, it is taken verbatim from Playwright's own per-distro dependency map —
the same data `playwright install-deps` acts on — read out of the **pinned**
`playwright-core@1.62.1`'s bundled copy (`lib/coreBundle.js`,
`debian12-x64.chromium`) rather than from Playwright's `main` branch.

That distinction matters and is a live trap: `main` has already moved to
Debian 13, whose list carries the 64-bit-`time_t` renames —
`libasound2t64`, `libatk1.0-0t64`, `libatspi2.0-0t64`, `libcups2t64`,
`libglib2.0-0t64`. **None of those packages exist in bookworm**, so copying
the current upstream list would fail the build outright. Re-read the map from
the installed version when bumping Playwright.

### `install-deps` wholesale is rejected on size

`playwright install-deps` installs its `tools` group as well as the browser
list. Measured against the bookworm package index (full dependency closure,
`Installed-Size` summed):

| Set | Packages | Installed | Download |
|---|---|---|---|
| `install-deps` equivalent (chromium + full `tools`) | 151 | **363.5 MB** | 108.5 MB |
| Chosen (chromium libs + fontconfig + 3 font packages) | 88 | **89.3 MB** | 35.5 MB |

The difference is almost entirely two things that buy nothing here:

- **`xvfb`: 247 MB on its own.** It is an X virtual framebuffer, for running
  a *headed* browser without a display. Headless Chromium needs no X server.
- **CJK/exotic font packages** (`fonts-ipafont-gothic`, `fonts-wqy-zenhei`,
  `fonts-unifont`, `fonts-tlwg-loma-otf`, `xfonts-scalable`): 82.6 MB, for
  scripts dilna's own UI does not use.

Image size is not a free variable in this repo: the `/data` volume has hit
ENOSPC in real deployments. 275 MB of avoidable growth is worth declining.

### Fonts are required, and are the actual Cairo fix

Chromium's libraries alone render text as blank boxes. Confirmed from inside
the image: `/usr/share/fonts` **does not exist** and `fc-list` is absent —
there are no font files and no fontconfig at all. So `fontconfig`,
`fonts-dejavu-core` and `fonts-liberation` (Latin / metric-compatible) plus
`fonts-noto-color-emoji` (emoji, else tofu) are installed.

This also corrects the assumption that motivated including `libcairo2` for
the image-generation case. It was investigated rather than assumed, and the
assumption does **not** hold: prebuilt `canvas` (node-canvas) does not link
the system Cairo. It ships its own `libcairo.so.2`, `libpixman-1.so.0`,
`libpng16.so.16`, `librsvg-2.so.2`, `libpango*` as separate `.so` files next
to `canvas.node`, resolved via an `$ORIGIN` RPATH. Its only *system*
requirements are `libuuid1`, `libblkid1`, `libmount1` and `zlib1g` — all four
already present in the base image (verified: `ldconfig -p` finds all of them).

So the Cairo-backed library was never blocked by a missing `libcairo2`. It
was blocked by the *same missing fonts* — text rendering silently producing
nothing. The single dependency layer does unblock both use cases, as hoped,
but via the font packages, not via `libcairo2`. (`libcairo2` is still
installed, because Chromium itself genuinely links it.)

Corollary worth recording: the `libjpeg.so.8` / `libgif.so.7` errors commonly
reported for node-canvas on slim images are **not** fixable with
`libjpeg62-turbo` — bookworm ships `libjpeg.so.62`, and `libjpeg.so.8` does
not exist in Debian. Those errors mean the vendored `.so`s were lost, which
under pnpm usually means a blocked postinstall, not a missing apt package.

### The browser binary is baked in, at a root-owned path

The libraries are only half the fix; the browser has to come from somewhere.
It is installed at build time with `npx playwright@1.62.1 install chromium`
into `/usr/local/share/ms-playwright`, pinned by
`ENV PLAYWRIGHT_BROWSERS_PATH`.

Pinning the path is what makes this work for a non-root session. Playwright
resolves its registry directory once at module init: an absolute
`PLAYWRIGHT_BROWSERS_PATH` is used verbatim, otherwise it falls back to
`${XDG_CACHE_HOME:-$HOME/.cache}/ms-playwright` (read directly from
`coreBundle.js`'s `registryDirectory`). **That default is actively harmful
here**: `toolchainEnv()` redirects every session's `XDG_CACHE_HOME` onto the
`/data` volume (ADR-0012 / #83), so an unpinned install would download
~170 MB of browser onto the volume that has already filled up — once per
deployment, and again after anything clears it.

Under `/usr/local` instead, there is one copy in an image layer, shared by
every session, on the read-only root that bwrap already binds into every
sandboxed command (`--ro-bind / /`). Sessions only ever read and execute it,
so it stays **root-owned** with `chmod -R a+rX` rather than being chowned to
`node`: a session cannot corrupt the shared browser for every other session.
The env var reaches sessions because `pi.ts` merges rather than replaces the
environment (`env: { ...options.env, ...grant.env }`).

`install chromium` is scoped deliberately — a bare `install` would also fetch
Firefox and WebKit, whose apt dependency sets are *not* installed here and
which nothing in this repo launches. `--with-deps` is avoided because it
would re-run apt with the full `tools` group, re-adding the 247 MB of xvfb
rejected above.

Note the Playwright **driver** is not in the runtime image: the build stage's
`pnpm install --prod` drops devDependencies, and `apps/web`'s `node_modules`
is never copied. That is correct and intentional — the image ships the
browser, and a session working on a repo brings its own driver via that
repo's own `pnpm install`, which then finds the pre-baked browser through
`PLAYWRIGHT_BROWSERS_PATH` instead of downloading one.

## Why not the alternatives

- **Install at session runtime.** Impossible, not merely undesirable:
  `apt-get` needs root, and ADR-0010 requires the server to run non-root for
  bwrap's unprivileged-user-namespace model. This is the constraint that
  forces the change into the image build.
- **A separate test/CI image.** Considered seriously, since this is the
  standard way to keep browser weight out of a runtime image. Rejected
  because it misreads where the need is. The consumer is not CI —
  `ci.yml` has no browser step and never runs Playwright. The consumer is a
  *session*, running inside the one runtime image, using the `browser-check`
  skill to verify UI work. A second image no session ever runs would leave
  the reported problem exactly as it is. Revisit if a browser-based CI job
  ever appears.
- **Let Playwright download the browser on first use.** This is what happens
  today by default, and it is the ENOSPC hazard described above: ~170 MB onto
  `/data`, per deployment, at the mercy of network availability mid-session.
- **A distro `chromium` package instead of Playwright's build.** Bookworm's
  `chromium` pulls a much larger dependency tree, and its version floats
  independently of what `playwright-core` expects, reintroducing the
  version-skew failures Playwright's pinned revisions exist to prevent.
- **Zero-system-dependency alternatives** (`@napi-rs/canvas`, `@resvg/resvg-js`)
  for the image-generation case. Genuinely attractive — both are fully static
  and need no system libraries — but they solve only the Cairo half and do
  nothing for the browser half, and they still need fonts to render text. The
  font packages here are a prerequisite for them too, so this change does not
  foreclose adopting one.

## Consequences

- Sessions can launch headless Chromium, screenshot pages, and run the
  `browser-check` / `verify` skills as those skills already document. UI work
  no longer has to be verified "by reasoning + vitest/jsdom only".
- The runtime image grows by ~89 MB installed (~35 MB download) plus the
  Chromium binary. Real, but a quarter of what the reflexive
  `playwright install-deps` would have cost, and it buys a capability two
  separate sessions have now been blocked on.
- The Cairo-backed image-generation path is unblocked by the font packages.
  No Cairo *library* change was needed, contrary to the initial assumption.
- **Chromium's own sandbox is not guaranteed.** A session's browser launch
  happens inside bwrap, so Chromium's sandbox needs a *nested* user
  namespace. That works in the reference deployment — which ships
  `seccomp-bubblewrap.json` specifically to permit `clone`/`unshare`/`setns`
  for bwrap — and was verified to work from inside a sandboxed session. It is
  not portable: a deployment using Docker's default seccomp profile, or a
  Kubernetes `securityContext` that blocks those syscalls, will see Chromium
  fail to spawn its zygote. Such a deployment should pass `--no-sandbox` to
  `chromium.launch()`. This is acceptable because the outer bwrap sandbox,
  not Chromium's, is dilna's actual isolation boundary.
- Playwright's version now appears in two places that must move together:
  `apps/web`'s `@playwright/test` and the Dockerfile's pinned
  `playwright@…  install chromium`. A mismatch means the driver wants a
  browser revision the image does not carry, and re-downloads it to `/data` —
  the exact failure this ADR avoids. Bump both together, and re-read the
  distro dependency list from the newly-pinned version.

## Verification status

The library set, package names, sizes, font absence, node-canvas linkage
model, `PLAYWRIGHT_BROWSERS_PATH` resolution, and the env-merge path were all
verified directly against the running image and the bookworm package index,
as cited throughout.

**The built image itself was not run.** The environment this change was
authored in has no Docker daemon and no root, so building the modified image
and launching Chromium inside it as the `node` user was not possible here.
The `docker-publish.yml` workflow builds the Dockerfile on every pull request,
which will catch a package-name or install-step error; an actual
launch-and-screenshot check as the unprivileged user still needs to be run
against the built image before this is relied on.
