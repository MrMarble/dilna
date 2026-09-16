# Install headless Chromium's shared libraries in the image, fetch the browser at runtime

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
the runtime stage's existing `apt-get` layer — and **only** those. The browser
binary is not baked in; a session fetches it at runtime with
`playwright install chromium` if and when it actually needs one.

The split follows the privilege boundary exactly. The shared libraries are the
part that genuinely *cannot* be obtained without root, so they have to be in
the image. The browser is a plain userspace download into a `node`-owned
directory — nothing about it requires root, so nothing about it requires being
in the image. Putting it there would charge every pull of this image ~650MB,
including the many deployments that never launch a browser at all.

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

### The browser is fetched at runtime, onto a shared persistent path

No `PLAYWRIGHT_BROWSERS_PATH` is set, and that is deliberate rather than an
omission. Playwright resolves its registry directory once at module init:
an absolute `PLAYWRIGHT_BROWSERS_PATH` wins if set, otherwise it falls back
to `${XDG_CACHE_HOME:-$HOME/.cache}/ms-playwright` (read directly from
`coreBundle.js`'s `registryDirectory`). In dilna that default lands exactly
where it should:

- `toolchainEnv()` points every session's `XDG_CACHE_HOME` at
  `DILNA_DATA_DIR/toolchain-home/cache` (ADR-0012 / #83), which is on the
  **persistent `/data` volume** — so a downloaded browser survives pod
  restarts, unlike anything under plain `$HOME`.
- That path is **shared across sessions**, not per-worktree, so the download
  is a one-time cost for the whole deployment rather than per session.
- It is already in the bwrap writable grant (`toolchainWritablePaths()`
  includes `xdgCacheHome`), so the unprivileged `node` user can actually
  write it.

All three were confirmed against a live deployment, which already had a
session-created `ms-playwright` registry at that path, owned by `node`.

A session that needs a browser therefore runs `playwright install chromium`
and it works, persists, and is reused. Scope matters twice over:

- `install chromium`, not a bare `install` — the latter also fetches Firefox
  and WebKit, whose apt dependency sets are *not* installed here and which
  nothing in this repo launches.
- `--only-shell` where a headed browser isn't needed: it fetches just the
  Chrome Headless Shell (**267 MB** with ffmpeg) rather than the full browser
  as well (**656 MB**), and headless `chromium.launch()` — which is all
  `check-page.mjs` and the `browser-check` skill ever do — uses the shell
  regardless. Both figures measured from the real registry.
- `--with-deps` must **not** be used: it shells out to apt, which a session
  cannot run, and would try to add the 247 MB of xvfb rejected above.

Note the Playwright **driver** is not in the runtime image either: the build
stage's `pnpm install --prod` drops devDependencies and `apps/web`'s
`node_modules` is never copied. A session brings its own driver via its
repo's `pnpm install`, which is also what provides the `playwright` CLI used
to fetch the browser — so driver and browser stay version-matched by
construction, with no pin in the Dockerfile to drift out of step.

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
- **Bake the browser into the image too.** This was the first version of this
  ADR, on the reasoning that a `/data` download risks ENOSPC. Reversed after
  measuring what it actually costs: a full `playwright install chromium`
  registry is **656 MB** (389 MB `chromium`, 262 MB `chromium_headless_shell`,
  5 MB `ffmpeg`), measured from a real session-created registry. Adding that
  to the image would have more than doubled it, and charged it to *every*
  deployment on *every* pull — including the majority that never launch a
  browser — to save a one-time download for the minority that do. The image
  is the wrong place to amortise a cost only some users incur. It also
  needed a Dockerfile-side version pin kept in lockstep with `apps/web`'s
  caret-ranged `@playwright/test`; letting the session's own driver fetch its
  own matching browser removes that failure mode entirely.
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
- The runtime image grows by ~89 MB installed (~35 MB download), and by
  nothing else — a quarter of what the reflexive `playwright install-deps`
  would have cost, and no browser weight at all.
- A session that wants a browser pays a one-time download onto `/data` —
  267 MB with `--only-shell`, 656 MB without — shared across sessions and
  surviving restarts. On the reference deployment (9.8 GB volume, 5.4 GB
  used) that fits, but it is not free: it is among the largest things a
  session can put on that volume, and the volume has hit ENOSPC before. If
  ENOSPC recurs, the levers are `--only-shell` and pruning old browser
  revisions from that registry (they accumulate one directory per Playwright
  bump), not moving the browser back into the image.
- Sessions need network access on first browser use. Already true of
  `mise install`/`pnpm install`, so no new dependency in practice.
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
- The apt list is the one thing still tied to a Playwright version, and it is
  tied loosely: it changes only when Playwright changes its *distro*
  requirements, not on every release. When bumping `@playwright/test`, re-read
  `debian12-x64.chromium` out of the newly-installed `playwright-core` and
  reconcile. There is no Dockerfile-side version pin to drift, because the
  browser is fetched by the session's own driver.

## Verification status

The library set, package names, sizes, font absence, node-canvas linkage
model, `PLAYWRIGHT_BROWSERS_PATH` resolution, and the env-merge path were all
verified directly against the running image and the bookworm package index,
as cited throughout.

The runtime-install half is verified more strongly than the rest, because a
live deployment already had a session-created registry to inspect:

- `playwright install chromium --dry-run` resolves its install location to
  `/data/toolchain-home/cache/ms-playwright/...` — the shared, persistent,
  bwrap-writable path, with no `PLAYWRIGHT_BROWSERS_PATH` set.
- That registry already exists on the reference deployment, owned by `node`,
  proving an unprivileged session can create and reuse it.
- The 656 MB / 267 MB figures are `du` of that real registry, not estimates.

**The built image itself was not run.** The environment this change was
authored in has no Docker daemon and no root, so building the modified image
and launching Chromium inside it as the `node` user was not possible here.
The `docker-publish.yml` workflow builds the Dockerfile on every pull request,
which will catch a package-name error; an actual launch-and-screenshot as the
unprivileged user still needs running against the built image before this is
relied on. That check is now cheaper to perform than it was under the
baked-in design, since it needs no image rebuild — only a
`playwright install chromium --only-shell` inside any session on the new
image.
