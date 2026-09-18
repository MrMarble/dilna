# Line-anchored, tag-guarded file editing (dilna's own read/edit pair)

## Context

ADR-0020 replaced the Claude backend with the pi stack and deliberately took
`pi-coding-agent`'s stock **tool factories** as given: `createReadTool`,
`createWriteTool`, `createEditTool` and friends, wired into a bare
`pi-agent-core` `Agent` in `apps/server/src/agents/pi.ts`. That was a
migration decision — get onto pi without rebuilding the tool surface.

The stock `edit` tool is `str_replace`-style: `{ path, edits: [{ oldText,
newText }] }`, matched against the original file, exact-then-fuzzy. It works,
and it has one structural weakness the survey in #138 identified as worth
fixing: **the model has to reproduce old file content byte-for-byte.** Every
failure mode follows from that — a misremembered indent, a smart quote, a
block that appears twice. When the match fails the model is told only *that*
it failed, so it re-reads the file and tries again, and a re-read of a
200-line file costs thousands of output tokens. Issue #138's survey of
[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) ("omp" — a sibling
fork of the pi lineage, not upstream of the `@earendil-works/pi-*` packages
dilna pins, so nothing here is obtainable by a dependency bump) found that omp
had replaced `str_replace` with exactly this: a **line-anchored,
content-hashed** patch language, plus the numbers to suggest it matters.

Two caveats shaped how much of that was worth taking. First, omp's headline
figures (Grok Code Fast "6.7% → 68.3%", "−61% output tokens") appear in its
README as a table linking to a blog post; nothing in the repo reproduces
them, and the one comparison harness it ships is a single Rust task with no
committed results. They are not a basis for a decision. Second, omp implements
the engine in Rust (`crates/pi-edit`, `pi-ast`, `pi-diff`) behind N-API —
vendoring that means a Rust toolchain in dilna's runtime image and a
cross-language boundary maintained against a fork that is not our dependency.

What *is* transferable is the mechanism, which is mechanical rather than
empirical: shorter addressing (a line number instead of a quoted block), no
exact-match requirement, and a refusal that carries enough information to
retry in one round trip instead of a re-read.

A second problem is independent of token cost. Today nothing stops an edit
from being applied to a file the model never saw. Within one session that is
narrow — each Session has its own worktree and dilna's own tools are the only
writers — but it is not zero (the model reads a file, edits it, then issues a
second edit against the text it read *before* the first landed), and the stock
tool's only defence is that a non-unique match errors. There is no way for an
edit to assert *which version* it was written against.

## Decision

**Add dilna's own `read`/`edit` pair, replacing pi's stock factories for
ordinary Sessions.** Three modules, split so that the pure engine carries
every rule and the tool layer only does I/O:

- **`agents/hashlineTag.ts`** — the snapshot tag:
  `xxh32(normalized text, 0) & 0xffff`, formatted as four uppercase hex.
  Normalization is omp's: strip a leading BOM, collapse CRLF/CR to LF, trim
  trailing spaces/tabs per line. **Byte-compatible with omp deliberately**,
  and pinned by `hashlineTag.test.ts` to the three vectors from omp's own
  `store.rs` tests (`80BA`/`5BF9`/`5D05`).
- **`agents/hashlineEdit.ts`** — the engine, a pure function
  (`{ text, tag, patch } → applied | refused`). The patch language is
  `PUT N.=M:` (replace inclusive lines), `PUT <N:` (insert before, `<1:` =
  head), `PUT >N:` (insert after) and `PUT >$:` (append). Body rows are
  `+TEXT` **final content**.
- **`agents/hashlineTools.ts`** — the disk-facing adapters: read the file,
  call the engine, write, render the reply.

`read` returns the file **tagged and numbered**:

```
[src/config.ts#1A2B]
4:export const DEFAULT_TIMEOUT_SECONDS = 30;
```

and `edit` takes that tag back:

```
path=src/config.ts  tag=1A2B
PUT 4.=4:
+export const TIMEOUT_MS = 30;
```

Three properties carry the value, and each is a deliberate choice:

1. **The tag is checked first, and a mismatch refuses the whole patch.** The
   refusal carries the tag the file actually has now, so the model re-issues
   against it in one round trip rather than re-reading. A partially applied
   edit against a moved file is exactly the corruption this exists to prevent,
   so nothing is written unless the tag matches.
2. **Body rows are final content, never a before/after diff pair.** The model
   writes what the lines should *become*, so it never reproduces old text —
   which is where the retry loop on unmatched `oldText` comes from. A literal
   line beginning with `+` is written `++…`; a lone `+` inserts a blank line.
3. **Line numbers are original-snapshot numbers, never shifted by an earlier
   hunk.** Operations are bucketed by anchor and applied in descending order,
   so an edit cannot move the ground under a later one. Every anchor in a
   patch comes from the one read the model did.

Deliberately **not** ported in this pass, all additive later without a
contract change: omp's `N*` tree-sitter block anchors (`PUT N*:`, which needs
a grammar dependency), `CUT`/register clipboard moves (`@name`, cross-file
structural moves), `REM`/`MV`, seen-line enforcement (refusing edits to lines
the model was never shown), and stale-tag *recovery* (omp remaps a stale
anchor when a uniform-offset remap with identical enclosing-construct identity
proves it safe; `hashlineEdit.ts` only refuses). `docs/research/omp-hashline-edit-engine.md`
§3 records the staging rationale.

The read-only subagent in `taskTool.ts` keeps the **stock** `read`. It has no
edit tool by construction (ADR-0034: read-only by omission), so a tag buys it
nothing and the numbered rendering would only spend tokens.

### Alternatives rejected

- **Vendor omp's Rust crates.** Highest fidelity — true `N*` block anchoring
  and streaming preview for free. Rejected: a Rust toolchain and native build
  artifacts in the runtime image, a second language in the server, and an
  N-API boundary maintained against a fork that is not our dependency. Worth
  revisiting only if the TypeScript core proves the round-trip win in dilna's
  own numbers.
- **Keep `str_replace` and add only tag refusal** ("shape C" in the research
  doc). Much cheaper, and it does buy the corruption guarantee — but the
  token and retry-loop wins, which are the point of the item, all come from
  line addressing. It would also mean two ways to address an edit rather than
  one. Rejected as not worth the surface for the guarantee alone.
- **Make the model copy a tag out of a read *without* also numbering lines.**
  Insufficient: without numbers there is nothing to anchor to, and the model
  would still be quoting text.
- **Keep pi's `read` and mint the tag inside `edit`.** Rejected because the
  model could then never *see* what it was anchored to — the tag would be
  tool-internal state rather than something the model can reason about. The
  legibility is the feature.
- **Reimplement everything pi's stock `read` does** (images, offset/limit,
  byte truncation, continuation notices) in dilna's version. Rejected: only
  the header and the numbering are needed, image reads cannot be numbered
  anyway, and a wholesale reimplementation is a large surface for no gain.
  The new `read` is text-only; the subagent keeps the stock tool for the rest.

## Consequences

- **This is a breaking change for the model, by design.** Every ordinary
  Session now reads numbered files and edits by anchor. The tool descriptions
  carry the whole contract (pi's `promptSnippet`/`promptGuidelines` are
  dropped by the `AgentTool` wrappers and ignored by the bare `Agent`, so the
  description string is the only channel — see §"What dilna does today" in
  the research doc). A model mid-task in a pre-existing session may fumble
  until it re-reads a file.
- **The tools keep pi's names (`read`, `edit`) and the flat `path` argument.**
  That is load-bearing, not cosmetic: `agents/confinement.ts` gates
  filesystem tools by a **name denylist** (`PATH_TOOLS`) reading
  `args.path`, and fails *open* on an unrecognised name or a relocated field.
  Renaming either tool, or moving `path`, silently removes the worktree
  boundary. `confinement.test.ts` enumerates the names for exactly this
  reason.
- **An edit never creates a file.** A create would bypass the anchor
  guarantee entirely, since there is no prior content to have been shown.
  `write` remains the creation path, and the edit tool says so.
- **The tag is not a security primitive.** 16 bits collide readily; its job is
  catching "this file moved under me", not resisting a deliberate collision.
  Documented in `hashlineTag.ts`.
- **Refusals are normal results, not crashes.** A stale tag returns
  `isError: true` with the reason and the current tag in the text, so the
  model can act on it. A no-op edit (a patch that reproduces the existing
  bytes) is also refused rather than reported as success — reporting a no-op
  as success traps the model into believing a change landed that never did.
- **XXH32 is hand-rolled** (~40 lines) rather than a dependency: Node's
  `crypto` has no xxhash digest, dilna has no xxhash package, and the
  algorithm has published test vectors. A dependency would be more to audit
  than the implementation is to read.
- **Unverified end-to-end.** The engine, both tools and the wiring are covered
  by unit tests (38 new), and the full suite passes. The behaviour of a real
  model driving the new contract has *not* been observed: the agent cannot
  spawn in the development container this was built in (the sandbox runtime
  binds a unix socket at startup, which that container refuses). The
  `editBench*` harness exists to measure exactly this and is ready to run
  wherever a Session can start.
- **No ADR previously covered the edit contract.** ADR-0020 Finding #2 decided
  only that worktree confinement was dilna's to solve, leaving the
  wrap-vs-reimplement question to the then-open #95; it said nothing about
  `oldText`/`newText`. This supersedes that gap for `read`/`edit`.
