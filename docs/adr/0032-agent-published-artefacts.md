# Agent-published Artefacts are immutable copies taken out of the Worktree

## Context

Issue #194 asked for a way to see an HTML report an Agent generated. Today the
Agent writes the file into its Worktree and the user can only read its *source*
in the diff panel — there is no path that renders it.

This is ADR-0031 (Attachments) run backwards: that ADR settled the user→Agent
file direction, this one settles Agent→user. The storage question has the same
shape and gets the same answer for the same reasons, so the two are deliberately
symmetric — one `attachments/` directory, one `artefacts/` directory, both
outside every Worktree.

Three questions had real alternatives.

**Where the bytes live.** The cheap option is to store a *reference*: the Agent
writes `report.html` in the Worktree, dilna records the path, and the serve
route reads it on demand. Nothing is copied and the artefact stays a real file
the user can commit. But a Worktree file is mutable and deletable by everything
that touches the repo — the next turn's `git checkout`, a branch switch, a
`rm -rf` in a cleanup script, or deleting the Session — so the link the user was
handed silently starts returning 404 with no record of what it used to show. A
report is a *result*, and a result that disappears when the working tree moves
on is not one.

**How dilna learns an artefact exists.** The alternative to an explicit tool is
inferring it: watch the write/edit tools for `.html` files and auto-publish. That
needs no new tool and no cooperation from the model. But it publishes every
scratch file, every fixture, every `test/fixtures/page.html` the Agent happened
to touch, and it has no way to learn a *title* — the panel would list a column of
filenames with no indication of which one is the thing the user asked for.

**How the HTML is served.** Attachments are served `Content-Disposition: inline`
and that is correct for a PNG. Reusing it verbatim for HTML is the tempting
default, and it is the one genuinely dangerous option in this design.

## Decision

**Storage:** bytes copied at publish time to
`<DILNA_DATA_DIR>/artefacts/<sessionId>/`, metadata in an `artefacts` table,
mirroring ADR-0031's layout. An artefact is **immutable**: publishing the same
path twice mints a second row rather than overwriting the first, so successive
versions of a report accumulate and can be compared. That is the feature, not a
side effect — "regenerate it with the numbers fixed" is the common case, and
losing the previous one makes the regeneration unreviewable.

**Declaration:** an explicit `dilna_publish_artefact(path, title?)` tool
(`agents/artefactTools.ts`), following `orchestratorTools.ts`'s pattern. The
Agent names a file it has written and supplies a human title. `path` is resolved
inside the Worktree and rejected otherwise, so the tool cannot be used to read
the rest of the host filesystem.

**Serving:** `GET /api/sessions/:id/artefacts/:artefactId` returns the bytes
under a deliberately hostile set of headers — `Content-Security-Policy:
sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:`,
`X-Content-Type-Options: nosniff`, and `Content-Disposition: inline`. The web UI
renders it in a `<iframe sandbox>`. The untrusted input is *the model's own
output*, and dilna serves it from the same origin as its own unauthenticated
`/api/*` surface; without CSP a generated report could fetch
`/api/sessions/…` and exfiltrate or mutate every Session on the instance.

**Scope:** v1 accepts HTML only. The tool rejects anything else with a message
naming what is supported, rather than storing a file the UI has no way to show.

## Consequences

- An artefact outlives the Worktree state that produced it. The tradeoff is
  duplicated bytes and the fact that editing `report.html` in the Worktree does
  *not* update a published artefact — the Agent has to publish again, which is
  what produces the comparable version history.
- Nothing prunes artefacts; they live until the Session is deleted, which
  removes the rows and the directory. Same tolerance, and same eventual
  revisit, as ADR-0031's orphaned uploads.
- The CSP is load-bearing. `style-src 'unsafe-inline'` is granted because a
  self-contained report is nearly always a `<style>` block and blocking it
  makes every artefact unreadable; `script-src` is **not** granted, so a report
  that depends on JavaScript renders inert. That is the intended trade: a
  static report that always renders beats an interactive one that widens the
  origin's attack surface. A future interactive-artefact requirement needs a
  separate origin (or a blob/`srcdoc` sandbox with no same-origin privileges),
  not a loosened header here.
- `ARTEFACT_MAX_BYTES` is enforced in the publish path, not in a route schema —
  the bytes arrive from the filesystem, not an HTTP body, so `index.ts`'s
  `bodyLimit` never sees them and cannot bound them.
- Issue #57 (rich repo file previews) shares the rendering surface but not the
  source: it previews files *in* the Worktree, this serves copies taken *out*
  of it. This ADR is deliberately the narrower of the two and leaves #57's
  markdown/image/PDF renderers unbuilt.
