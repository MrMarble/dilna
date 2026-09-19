# Artefacts beyond HTML: markdown, PDF and images, each rendered by the browser

## Context

ADR-0032 shipped publication of Agent-produced files with a deliberate v1 scope:
**HTML only**. The `PUBLISHABLE` map in `sessions/artefacts.ts` accepted
`.html`/`.htm` and rejected everything else, and the serve route handed all bytes
to the browser under one hostile header set — `sandbox; default-src 'none'` — with
the web app rendering them in `<iframe sandbox="">`.

Two things pushed past that scope.

**The HTML constraint was real but under-explained.** A published report runs no
JavaScript and loads no remote assets, so a report written against a Tailwind CDN
renders as unstyled text. The tool description said "keep reports self-contained
with inline CSS", which describes a *style* rather than the mechanical failure, and
Agents kept reaching for the CDN anyway. The fix here is not to loosen anything —
it is to name the failure concretely where the Agent reads it.

**Other kinds were genuinely useful and genuinely cheap.** An Agent asked for a
report often has a PDF, a markdown document, or a chart image instead, and the only
way to hand one over was to wrap it in throwaway HTML. That is the same "wrap it in
HTML" workaround that ADR-0038 removed for images.

Three decisions had real alternatives.

**How much of the header set the new kinds need.** The tempting default is to serve
everything under ADR-0032's headers, since "stricter is safer". It is not stricter
here — it is *broken*. `sandbox` makes Chrome refuse to hand a PDF to its native
viewer, and `default-src 'none'` blocks the blob URLs that viewer spins up, so a PDF
served that way is a blank frame.

**Whether markdown becomes HTML server-side.** Rendering markdown to HTML on the
server would let the client reuse the existing iframe path for one more kind. It
would also mean dilna itself producing HTML out of model output — a second
injection surface with a different sanitizer, sitting inside the origin.

**Whether to accept SVG.** `.svg` is an image extension, so "add image support" reads
as including it. It is XML document markup: it can carry `<script>`, fetch remote
resources, and pull in `<foreignObject>` HTML.

## Decision

**Kinds.** `ArtefactKind` widens from `"html"` to `"html" | "markdown" | "pdf" |
"image"`, and `PUBLISHABLE` maps one MIME type per accepted extension. The set is
still a closed union rather than a raw MIME type: what dilna can *render* is much
smaller than what an Agent could publish, and the publish tool rejects anything
outside it, because an artefact the UI cannot show fails long after the turn that
produced it.

`.svg` is **not** accepted. Serving it inline is the same hazard as HTML with none of
HTML's sandboxing — an SVG image renders in an `img`/`embed` context, where an iframe
`sandbox` attribute cannot be applied at all. An Agent that wants to publish vector
art inlines it into an HTML artefact, which *is* sandboxed.

**Serving splits in two, per kind.** `isSandboxedKind()` in `packages/shared` is the
single predicate both the route and the viewer ask:

- `"html"` keeps ADR-0032's headers verbatim — `sandbox; default-src 'none';
  style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none';
  form-action 'none'` — and renders in `<iframe sandbox="">`. Unchanged, and not to
  be changed.
- Every other kind gets `default-src 'none'; base-uri 'none'; form-action 'none'`
  **without `sandbox`**: still nothing fetchable and nothing executable, but the
  browser is free to render the bytes it was handed.

Markdown is additionally served `Content-Disposition: attachment` so a click-through
downloads the source rather than rendering it as a plaintext page.

**Markdown never becomes server-side HTML.** The route returns
`text/markdown; charset=utf-8` verbatim; the web app fetches it and renders it with
the same `Markdown` component the chat uses, which configures no `rehype-raw`, so raw
HTML in a `.md` file is escaped and shown as text. So there is exactly one place in
the app deciding what model-authored markdown may become — and it is a place with no
network or same-origin access. The viewer additionally rejects a response whose
`Content-Type` is not `text/*`, so the promise can't quietly start returning
something else.

**The inert arm's safety rests on the renderer, not the header.** That is the whole
argument for it, and it is why the kinds are enumerated rather than sniffed: images
are bitmaps, SVG is refused at publish time, markdown is escaped client-side, and PDF
renders in the browser's own plugin process. Widening `PUBLISHABLE` with something
that executes means revisiting this split, not just adding a map entry.

**The raw toggle** is a markdown-only affordance in `ArtefactViewer`. It is a render
switch over bytes already fetched — deliberately not a refetch, since artefacts are
immutable and a toggle that round-trips is a toggle that can fail. The fetch is owned
by the viewer rather than by either mode, for the same reason.

**The tool description names the failure.** `PUBLISH_DESCRIPTION` states in concrete
terms that a published document runs no JavaScript and loads no remote assets, and
that a CDN link therefore "silently does nothing". Images stay out of scope as
artefacts for *sending* — `dilna_send_image` (ADR-0038) already covers putting a
picture in the conversation — but publishing an image file is now allowed, which is
what closes the gap for a chart the Agent wrote to disk.

`ARTEFACT_MAX_BYTES` rises 8MB → 25MB: 8MB was sized for an HTML report with a
base64 image or two and is tight for a generated PDF, which is mostly embedded fonts.

## Consequences

- No migration. `kind` was already stored rather than re-derived per read (ADR-0032's
  schema comment), so widening the accepted set cannot retroactively reclassify an
  already-published artefact.
- A future kind that executes — anything with scripts, or SVG — needs a *third* arm
  here, or the separate-origin answer ADR-0032 already names. Adding it to
  `PUBLISHABLE` alone is the mistake this ADR exists to prevent.
- The PDF arm is not uniformly testable: a headless test can assert the headers and
  the absence of `sandbox`, but whether a given browser's viewer actually paints is
  not something the suite can see. The header split is the testable half.
- Markdown raw mode shows the source of a file the user could already download. It is
  a convenience, not an escape hatch from the sandbox — that is the "open in a new
  tab" link, which for markdown now downloads rather than navigates.
- The viewer's `switch` over `ArtefactKind` ends in a `never` check, and
  `ARTEFACT_KIND_ICONS` is a total `Record`, so adding a kind is a compile error in
  two places rather than a blank panel row at runtime.
- Issue #57 (rich repo file previews) is still not this. It previews files *in* the
  Worktree from the context panel; this widens what a published copy can be. The two
  now share a renderer vocabulary and could share `artefact-render.tsx`'s components,
  but #57 still needs its own file-content endpoint and its own sandbox reasoning —
  a Worktree file is not a published snapshot.
