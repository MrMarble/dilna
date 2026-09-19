# CodeGraph as a first-class tool, not a bash incantation

## Context

[Issue #119](https://github.com/MrMarble/dilna/issues/119) wired
[CodeGraph](https://github.com/colbymchenry/codegraph) into every Session: the CLI is
installed in the runtime image, `SessionManager.create` runs `codegraph init --yes`
against each fresh Worktree, and `startPi` appends a paragraph to the system prompt
pointing at `codegraph explore` — but only when `.codegraph/` actually appeared.

That wiring is correct and incomplete. The Agent reaches the graph only through the
*sandboxed bash tool*, so using it costs a Bash call whose command line the model has
to reconstruct from prose every time, and whose meaning is invisible to anything that
inspects the tool list. The evidence that this loses is in dilna's own history: a
session found and used `codegraph impact ArtefactKind` (commit `8ce12a6`, "Found by
auditing the widening with `codegraph impact ArtefactKind` rather than by grep") and
then, three minutes later in the same session, did the follow-up work with `rg`
anyway. Nothing about that session lacked the binary or the index.

Meanwhile upstream's own *documented* install path does more than dilna borrowed:

- **An MCP server** (`codegraph serve --mcp`) exposing a **single** tool,
  `codegraph_explore`. Upstream's README is explicit that this is deliberate —
  "Measured agent behavior showed that one strong tool steers agents better than a
  menu of narrower ones". `codegraph_explore` takes a natural-language question or a
  bag of symbol names and returns the relevant symbols' verbatim, line-numbered
  source grouped by file, the call paths between them (including dynamic-dispatch
  hops grep can't follow), and a blast-radius summary. The other seven tools
  (`node`, `search`, `callers`, `callees`, `impact`, `files`, `status`) stay
  *functional but unlisted*; everything they return already arrives inline on
  explore.
- **Server-level instructions** shipped in the MCP `initialize` response
  (`dist/mcp/server-instructions.d.ts`) — a playbook that tells the Agent to reach
  for explore *before* reading files, to trust the result instead of re-verifying it
  with grep, and to check the staleness banner after edits. This is the largest
  single piece of upstream material dilna is not using, and it is the piece that
  addresses the observed behaviour directly.
- **A marker-fenced block** in each agent's instructions file (`.claude/CLAUDE.md`,
  `AGENTS.md`, `GEMINI.md`). Upstream's changelog explains why it exists (#704):
  **task-tool subagents and non-MCP harnesses never see the MCP `initialize`
  instructions.** That is exactly dilna's case — `task` subagents (ADR-0034) are
  constructed by hand with a fixed system prompt and no MCP client anywhere.

So the question is not "should dilna adopt codegraph's installer", since there is no
MCP client in `pi-agent-core` to point one at. It is: **which of those three
surfaces can dilna reproduce natively, and what does each actually buy?**

The measurement matters, because the fix is not free. Upstream's own numbers put
CodeGraph at 44% lower cost and 62% fewer tokens *processed*, while leaving ~80%
**more retrieval context resident** at the end of a session — one dense payload
stays in the window where a grep-and-read loop's small results get evicted. A tool
that returns 20-22 KB per call is a different trade than a bash call returning the
same bytes, and only on an indexed repo.

## Decision

### A native `codegraph` tool, with upstream's single-tool shape

`apps/server/src/agents/codegraphTool.ts` registers one tool named `codegraph`,
with one function-shaped parameter upstream calls `query` plus the two knobs its
CLI already exposes (`max_files`, `path`). Its `execute()` shells out to
`codegraph explore <query> --max-files N --path <worktree>` — the *same* code path
the MCP tool runs in-process, so the output is the MCP tool's output.

Only `explore` is exposed, mirroring upstream's measured choice rather than
re-deriving it. The narrower CLI commands (`callers`, `callees`, `impact`, `node`,
`files`) are not a tool menu here; an Agent that wants one asks explore a more
specific question, and the blast-radius section usually answers it already.

### The MCP server-instructions playbook moves into the tool description

`pi-agent-core` has no MCP client, so the `initialize` handshake that carries
upstream's playbook has nowhere to land. The tool's `description` is the only
equivalent surface, and it is a *better* one: an Agent with a dozen tools weighs
descriptions against each other, and the read/grep/find/ls descriptions it is
weighing this against say nothing about code graph structure.

The description carries, compressed: use this instead of a grep/read loop for
structural questions *and* before editing; treat the returned source as already
read; don't re-verify with grep; don't hand-reconstruct a flow; after an edit, check
the staleness banner. The long anti-pattern catalogue is not copied — a tool
description is read on every turn.

### Registration is per-worktree, next to the worktree it indexes

The tool is appended to `startPi`'s tool array only when that Worktree has a
`.codegraph/` directory, at the same `existsSync` that gates the system-prompt note.
A Session whose `codegraph init` failed, or whose repo the CLI can't parse, simply
has no such tool — which is the same reason the prompt note was made conditional in
the first place. A second instance of dilna's own checkout is precisely where a
tool that silently answers from someone else's branch would do damage: worktrees
under one repo are siblings on disk (which is why `denyReadPaths` masks them one by
one), two Sessions on the same repo are routinely live at once, and `codegraph
explore` ships a worktree-mismatch notice *because* agents in nested worktrees
otherwise "silently trust main-branch results" (upstream issue #155).

Because the only real hazard is a *missing* index — where the CLI prints guidance to
stderr and exits 1 with no stdout — `execute()` resolves that case as an ordinary
result text rather than a thrown error. `pi-agent-core` derives a tool result's
error flag solely from whether `execute()` threw (ADR-0034 notes this explicitly),
and upstream's own tools code makes the same call for the same reason: "an
`isError: true` early in a session teaches the agent the toolset is broken and it
stops calling codegraph entirely". A missing index is not a failure; it is a
Session that should carry on with grep.

### The system-prompt note stays, and grows a boundary

The note keeps its place — it reaches the *whole* session context, not one tool
description — but stops being the only place the tool is explained, and gains the
one line the Playbook note in upstream's instructions file gained for the same
reason: if there is no `.codegraph/` in this worktree, don't go looking for one via
bash.

`task` subagents still do not get the tool. Upstream added its instructions-file
block specifically so read-only subagents would use CodeGraph, and dilna's
subagents are the closest analogue. They are left alone here on purpose: ADR-0034's
subagents exist so heavy exploration happens *outside* the parent's context, and a
tool whose output is a dense 20 KB payload is the opposite of that. A subagent
handing back one short answer is doing its job; giving it explore would invite it to
spend 20 KB re-deriving structure and then summarize it.

### Everything else upstream's installer does is skipped, with reasons

- **Hooks.** There are none to borrow. `codegraph install` writes agent MCP configs,
  an auto-allow permissions list (Claude Code only), and the instructions-file
  block; the CLI ships no hooks, and there is no session-start/end hook in the
  package. The per-project `init`/`sync` automation dilna would otherwise want is
  already handled by `initCodegraph` plus a plain `git pull` + `codegraph sync` in
  the README's CI example.
- **`codegraph install` itself.** It detects and configures nine other agents; none
  is pi. Running it would install an MCP server nothing can connect to.
- **The instructions-file block.** Its content is agent-directed, and dilna's
  equivalent surface is the system prompt (already covered) — not a file in the
  repo. Writing `CODEGRAPH_START`/`CODEGRAPH_END` markers into a repo's `CLAUDE.md`
  would put dilna-authored text inside the user's repository, show up in its diffs,
  and claim a tool that only exists inside dilna.

### The bash path is unchanged

`codegraph` remains on `PATH` inside the sandbox, and the note still names
`codegraph explore` as the CLI equivalent. Upstream's README documents the same two
surfaces side by side, and the bash route is the fallback for a Session that
somehow has no index but wants to check (`codegraph status`, `codegraph files`).

## Why not the alternatives

- **Build an MCP client into `pi-agent-core`**: rejected — a new dependency, a new
  lifecycle (server spawn, handshake, teardown, reconnect) and a new failure mode
  per Session, to reach a tool whose implementation is a CLI invocation dilna can
  already make. `pi-coding-agent` documents "No MCP" as deliberate; dilna's
  equivalent of that decision is a native tool.
- **Register the tool unconditionally and let it fail**: rejected — a tool that
  errors on every call in an unindexed Session is worse than no tool, and the
  conditional registration is one `existsSync` on a path the surrounding code
  already computes.
- **Pass `projectPath`/`--path` to a sibling worktree's index**: rejected outright.
  Silently answering from another branch is the exact failure upstream's
  worktree-mismatch notice exists to surface, and dilna *knows* the correct path.
- **Wrap the CLI's JSON output (`query -j`, `callers -j`, …) into a typed tool
  result instead of returning explore's markdown**: tempting, and it would compose
  better with the UI. Rejected for now — explore's payload is source plus call paths
  plus blast radius in one round trip, which is the property being bought, and
  reformatting it would mean re-deriving upstream's ranking and rendering.
- **Teach the subagent about explore** (upstream's #704 fix): deferred, not
  rejected. Worth measuring against ADR-0034's context-isolation goal first; the
  cost is a 20 KB payload landing in the one context that exists to stay small.

## Consequences

- A Session on an indexed repo gains a tool whose output is large and sticky. The
  ~80%-more-residual-context figure is the price of the 62% fewer tokens processed;
  on long compactions (ADR-0023) it shifts work to the compactor.
- Output is capped (`CODEGRAPH_MAX_OUTPUT_CHARS`, head-preserving) and the
  tool says so in-line when it truncates, so one call cannot fill the window.
  Explore's own budget already scales with project size; the cap is the backstop
  for the case where it doesn't.
- `Grep`/`Read` stay available everywhere and are never blocked. The bet is the one
  upstream measured, that a better-described tool wins on its own merits; a Session
  that ignores `codegraph` loses nothing it had before.
- The tool is absent in `startOrchestrator` (no worktree, no filesystem tools —
  ADR-0021) and in `task` subagents (by omission, as above).
- Every Worktree that `codegraph init --yes` parsed now costs one extra binary
  invocation per `explore` call (~0.3 s measured on dilna's own checkout, plus a
  cold start on the first call).
- The tool's shape is upstream's to change: it is a subprocess against
  `@colbymchenry/codegraph@1.6.0`, pinned in the Dockerfile, and a breaking CLI
  change there is a dilna bug. Because that failure is *silent* — `execute()`
  returns "use grep/read instead" and nothing reaches the logs — the pin is
  enforced rather than trusted: the Dockerfile asserts
  `codegraph --version` equals `ARG CODEGRAPH_VERSION` and that `explore`
  still parses at build time, a dedicated `codegraph-surface` CI job installs
  that same pinned version (read out of the Dockerfile, so a bump cannot leave
  the job testing something nothing ships) and runs
  `codegraphCli.test.ts` against the real binary, and that test skips cleanly
  wherever codegraph isn't installed. Upstream ships roughly a release a week
  (46 versions as of 2026-09), so this is the difference between a red build
  and a feature that quietly stops being used.
