# Render images with node-canvas, and screenshot HTML with headless Chromium

## Context

Sessions were failing to render HTML to an image. The attempted approach was
`jsdom` + a library in the `html-to-image` / `html2pic` family, with the
`canvas` npm package (node-canvas, the Cairo-backed Canvas API implementation
for Node) installed to supply the Canvas API that jsdom lacks. It didn't work,
and the failure was read as "the sandbox is missing Cairo" — a plausible guess,
since sessions run as the unprivileged `node` user with no root/sudo
(ADR-0010), so a missing system library is genuinely unfixable at runtime and
would have to be added to the image (ADR-0012's `libatomic1` precedent).

That guess was wrong in an expensive direction: it points at adding
`libcairo2`, `libpango-1.0-0`, `librsvg2-dev` and a compile toolchain to the
Dockerfile — ~100MB of packages, on a `/data` volume that has hit ENOSPC
before — none of which would have fixed anything.

Three separate questions were tangled together. Each was answered empirically,
inside the sandbox, as the `node` user.

## Decision

### 1. node-canvas needs no system libraries — the blocker is the build allowlist

node-canvas's `install` script is
`prebuild-install -r napi || node-gyp rebuild`. On linux-x64 the first branch
succeeds: a prebuilt binary exists and downloads in about a second. That
prebuild **bundles its own Cairo stack** — `ldd` on the installed
`canvas.node` resolves `libcairo.so.2`, `libpango-1.0.so.0`, `librsvg-2.so.2`,
`libjpeg.so.62`, `libgif.so.7`, `libpixman-1.so.0`, `libharfbuzz.so.0` and the
rest **into `node_modules/canvas/build/Release/`** via RPATH, not into
`/usr/lib`. Only libc/libm/libgcc/libstdc++ come from the system. The whole
package is 24MB.

So the standing practice of `pnpm install --ignore-scripts` (recorded in repo
memory as the way to install in this sandbox) was the entire failure:

```
$ pnpm install --ignore-scripts && node -e 'require("canvas")'
Error: Cannot find module '../build/Release/canvas.node'
```

The package is present, the binary was never fetched. The error names a
missing `.node` file, which reads like a broken native build and invites the
"missing Cairo" diagnosis — but no system library is involved.

Two traps confirmed while pinning this down, both of which fail *quietly*:

- `pnpm rebuild canvas` does nothing without an allowlist entry. No error, no
  output, no binary.
- pnpm 10+ no longer reads these settings from a `pnpm` key in
  `package.json`; it warns `The "pnpm" field in package.json is no longer read
  by pnpm` and ignores them. They belong in `pnpm-workspace.yaml`, which is
  where this repo already keeps `better-sqlite3`/`esbuild`/`lefthook`.

With `canvas: true` in `allowBuilds` and `onlyBuiltDependencies`, a plain
`pnpm install` builds it and it renders PNG, JPEG, and SVG-via-librsvg.

**No Cairo/Pango/rsvg packages are added to the Dockerfile.** They would be
dead weight the addon never dlopens.

### 2. Fonts are the one real image-level gap

`node:24-bookworm-slim` ships **zero** text fonts and no fontconfig
configuration. node-canvas's prebuild can bundle libraries but not fonts, so
Cairo falls back to a glyph-less default:

- `Fontconfig error: Cannot load default config file` on every run
- `fillText` emits tofu boxes (□□□) while gradients, paths, arcs and SVG
  rasterisation render perfectly — a valid PNG of unreadable text
- the diagnostic tell: `measureText("Hello World")` returns **110.0 for all of**
  `sans-serif`, `serif`, `monospace` and a named family. Identical metrics mean
  no real font is loaded.

A session cannot fix this itself: fonts need root, and npm font packages
(`@fontsource/*`) ship only woff/woff2, which node-canvas's `registerFont`
rejects with `Could not parse font file` — it needs TTF/OTF. Confirmed that
`registerFont` with a genuine TTF does render real glyphs, so the mechanism
works; there is simply nothing on disk to register (the only TTFs anywhere on
the system are three icon fonts inside playwright-core).

Added to the runtime stage: `fontconfig`, `fonts-dejavu-core`,
`fonts-liberation`. ~4MB, versus the ~100MB the Cairo `-dev` route would have
cost. Liberation is metric-compatible with Arial/Times/Courier, so content
requesting those common families doesn't fall back. These are also fonts a
headless Chromium needs, so the cost is shared with follow-on work.

### 3. jsdom + node-canvas cannot screenshot HTML — this is structural

This is the part worth writing down, because the original goal was
HTML-to-image and the answer is that this stack can never deliver it.

jsdom has no layout engine. It parses HTML and resolves the CSS cascade, but
never performs layout, so every element measures zero:

```js
el.getBoundingClientRect(); // { w: 0, h: 0, top: 0, left: 0 }
el.offsetWidth;             // 0
getComputedStyle(el).width; // "300px"  ← the declared value, echoed back
```

The computed style reports `300px` for a box that is actually 0×0. Libraries
in the `html-to-image` family walk the DOM asking for precisely that geometry,
and also call `getComputedStyle(el, pseudoElt)` for pseudo-elements, which
jsdom refuses outright:

```
Error: Not implemented: window.getComputedStyle(elt, pseudoElt)
```

Installing `canvas` *does* upgrade jsdom — `canvas.getContext("2d")` returns a
real context instead of `null`, which is why installing it looks like
progress. But a context is only a surface to draw *on*. Nothing decides where
anything goes. Adding more shims moves the error around
(`HTMLCanvasElement is not defined` → `SVGImageElement is not defined` → the
`getComputedStyle` throw) without approaching a rendered page.

**node-canvas rasterises Canvas API drawing commands, not HTML.** Faithful
HTML screenshotting requires a browser engine.

### Division of labour

- **Charts, diagrams, social cards, compositing, SVG → PNG**: node-canvas.
  Works now; this ADR's changes are all it needs.
- **Screenshot of a rendered HTML page**: headless Chromium via Playwright
  (`@playwright/test` is already a devDependency of `apps/web`, with a
  `browser-check` skill driving it).

Chromium's system dependencies are a **separate** problem and are deliberately
not solved here. A Chromium binary is already downloaded under
`ms-playwright/` but cannot start: `ldd` reports **24** missing shared objects
and launching it dies with
`error while loading shared libraries: libglib-2.0.so.0`. node-canvas's
bundled copies do not satisfy it — they sit in `node_modules` on an RPATH
private to the addon, and Chromium additionally needs `libnss3`, `libgbm1`,
`libxkbcommon0`, `libasound2`, `libatk-1.0` and others that node-canvas has no
reason to carry. That work belongs to the in-flight headless-browser session;
this ADR leaves it a clean, non-overlapping slice (the fonts added here are
the only intersection, and they help both).

## Why not the alternatives

- **Add `libcairo2`/`libpango-1.0-0`/`librsvg2` to the image**: unnecessary.
  The prebuild bundles and RPATHs its own. Verified by `ldd`, not assumed.
- **Add the `-dev` headers and compile node-canvas from source**: strictly
  worse. The prebuild already works on linux-x64 in about a second; source
  compilation adds ~100MB of headers to a volume that has hit ENOSPC, plus
  minutes of build time, for an identical result. The runtime stage already
  carries `build-essential`/`python3`/`pkg-config`, so the `node-gyp rebuild`
  fallback still exists for a platform with no matching prebuild — it just
  isn't this one.
- **Drop `--ignore-scripts` generally**: `--ignore-scripts` is a real
  supply-chain control, and pnpm's allowlist exists precisely so it can be
  relaxed per package. Allowlisting `canvas` is the narrow version of this.
- **Keep pushing jsdom + `html-to-image`**: no shim count fixes a missing
  layout engine. Chasing it produces a moving target of undefined globals that
  terminates at `getComputedStyle` being unimplemented.
- **Make node-canvas do HTML by hand-computing layout**: reimplementing CSS.
- **Wait for the Chromium session and do nothing**: Canvas-API rendering is a
  real, distinct capability that works today for a one-line config change. The
  two are complementary, not competing.

## Verification

All as the unprivileged `node` user, inside the sandbox:

1. `pnpm install --ignore-scripts` leaves canvas unbuilt —
   `Cannot find module '../build/Release/canvas.node'`.
2. `pnpm rebuild canvas` without the allowlist: silent no-op.
3. `pnpm` allowlist in `package.json`: ignored, with a warning.
4. Allowlisted in `pnpm-workspace.yaml`, plain `pnpm install` runs
   `prebuild-install -r napi`, producing `canvas.node`; a fill + `toBuffer`
   yields a valid PNG.
5. `ldd canvas.node`: Cairo/Pango/rsvg/jpeg/gif/pixman/harfbuzz all resolve
   into `node_modules`, confirming no system dependency.
6. Rendered a gradient + arc + text PNG (4831 bytes, magic `89504e47`), a JPEG
   (magic `ffd8`), and an SVG rasterised through bundled librsvg. **Viewing the
   PNG** showed correct graphics and tofu-box text — the fonts finding, which
   byte counts alone would have hidden.
7. `measureText` identical (110.0) across four families → no font loaded.
   `registerFont` with a real TTF then drew genuine glyphs (1518 dark pixels,
   visually confirmed).
8. jsdom: `getBoundingClientRect` 0×0, `offsetWidth` 0, computed width
   `"300px"`. `html-to-image` under jsdom fails with
   `Not implemented: window.getComputedStyle(elt, pseudoElt)`.
9. Chromium: 24 missing shared objects; launch fails on `libglib-2.0.so.0`.

**Not verified**: the Dockerfile change itself is unbuilt here — the sandbox
has no root and no Docker daemon, so `fonts-dejavu-core` resolving the tofu
boxes is inferred from the `registerFont` result (a real font file fixes glyph
rendering) rather than observed end-to-end. First image build should confirm
`fc-list` is non-empty and that `measureText` widths diverge across families.

## Consequences

- node-canvas works in any repo a session touches, provided the session
  allowlists it — and the `rendering-images` skill now says so, including the
  `--ignore-scripts` trap, which is otherwise a multi-hour dead end that
  misdirects toward system libraries.
- Text rendering becomes legible for anything Cairo-backed, and for a future
  headless Chromium, at ~4MB.
- Repo-level `allowBuilds`/`onlyBuiltDependencies` govern **dilna's own**
  install. A session working on some other repo must add the entry to *that*
  repo's config; the skill covers it, and `npm install canvas` is the quicker
  route for a throwaway probe since npm runs install scripts by default.
- HTML-to-image is explicitly **not** solved by this ADR, and pointing a
  session at jsdom + node-canvas for it is now documented as a wrong turn.
- The image still carries `build-essential`/`python3`/`pkg-config`
  (ADR-0012), so the source-compile fallback remains for platforms without a
  prebuild.
