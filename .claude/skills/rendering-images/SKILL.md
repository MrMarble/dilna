---
name: rendering-images
description: Produce an image from code — charts, diagrams, social cards, or a screenshot of a rendered HTML page. Covers the `canvas` (node-canvas) package, why `--ignore-scripts` silently breaks it, and when node-canvas is the wrong tool and headless Chromium is the right one.
---

# Rendering images

## Pick the right tool first

The two jobs look similar and are not:

| You want | Use | Why |
| --- | --- | --- |
| Draw with the Canvas API (charts, diagrams, social cards, compositing, SVG → PNG) | `canvas` (node-canvas) | Works today, no image change needed. See below. |
| A faithful screenshot of an **HTML page** — CSS layout, flexbox/grid, web fonts | Headless Chromium (Playwright) | node-canvas **cannot** do this. See "Why not jsdom". |

If you are reaching for `jsdom` + `canvas` + an `html-to-image`-family library
to screenshot a page, stop — that combination does not work, and the reason is
structural, not a missing dependency.

## node-canvas: the one thing that breaks it

node-canvas is a native addon. It gets its binary from an `install` script
(`prebuild-install -r napi || node-gyp rebuild`). pnpm does not run install
scripts for a package unless that package is **allowlisted**, so:

```bash
pnpm install --ignore-scripts    # canvas is left UNBUILT
node -e 'require("canvas")'
# Error: Cannot find module '../build/Release/canvas.node'
```

That error means "the build script never ran". It does **not** mean a system
library is missing — the usual first guess, and a dead end that leads to
trying to `apt-get install libcairo2-dev` with no root.

`pnpm rebuild canvas` does **not** rescue it either: without the allowlist
entry it exits silently having done nothing.

The fix is to allowlist it in `pnpm-workspace.yaml` (pnpm 10+ reads these
settings there, **not** from a `pnpm` key in `package.json` — that key is
ignored with a warning):

```yaml
allowBuilds:
  canvas: true

onlyBuiltDependencies:
  - canvas
```

Then a plain `pnpm install` builds it. Confirm with:

```bash
node -e 'const{createCanvas}=require("canvas");
const c=createCanvas(20,20);c.getContext("2d").fillRect(0,0,20,20);
console.log("ok",c.toBuffer("image/png").length)'
```

For a throwaway probe outside a repo, `npm install canvas` (npm runs install
scripts by default) is quicker than setting up the allowlist.

## No system libraries are needed

The linux-x64 prebuild ships Cairo, Pango, librsvg, libjpeg and libgif
*inside* the package and links them by RPATH, so `libcairo2` and friends do
not need to be in the image. `ldd node_modules/canvas/build/Release/canvas.node`
resolves them into `node_modules`. Don't add `-dev` packages to chase a
build error — check the allowlist first.

## Fonts

The image installs `fonts-dejavu-core` + `fonts-liberation`. Without fonts,
text silently renders as tofu boxes (□□□) while graphics render fine, and
every font measures the same width. If you need a *specific* font, ship the
TTF/OTF and register it — `registerFont` must be called **before** the
context is created, and it rejects woff/woff2:

```js
const { registerFont, createCanvas } = require("canvas");
registerFont("./MyFont.ttf", { family: "My Font" });
const ctx = createCanvas(400, 100).getContext("2d");
ctx.font = '28px "My Font"';
```

## Why not jsdom for HTML → image

jsdom has no layout engine. It parses HTML and resolves the CSS cascade, but
it never lays anything out, so **every element measures zero**:

```js
el.getBoundingClientRect(); // { width: 0, height: 0, top: 0, left: 0 }
el.offsetWidth;             // 0
```

`getComputedStyle(el)` echoes back the declared `width: 300px` while the
element's actual box is 0×0. `html-to-image` and friends walk the DOM asking
for exactly this geometry, and additionally call
`getComputedStyle(el, pseudoElt)` for pseudo-elements, which jsdom throws
`Not implemented` on. Installing `canvas` gives jsdom a real 2D context —
`getContext("2d")` stops returning null — but that only provides a surface to
draw *on*; nothing computes where anything goes. The output is blank or the
call fails outright.

So: node-canvas rasterises **Canvas API drawing commands**, not HTML.

## Screenshotting a real page

Use Playwright (`@playwright/test` is a devDependency of `apps/web`) and the
`browser-check` skill. Note that headless Chromium needs a set of system
libraries (`libnss3`, `libgbm1`, `libxkbcommon0`, ...) that are **separate**
from node-canvas's needs and which node-canvas's bundled copies do not
satisfy. If `chrome` fails with
`error while loading shared libraries: libglib-2.0.so.0`, those packages are
missing from the image and no amount of node-canvas work will help.
