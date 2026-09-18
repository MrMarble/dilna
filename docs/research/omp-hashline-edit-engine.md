# oh-my-pi's "hashline" edit engine — what it is, and what porting it would cost dilna

Research for [Feature survey: port borrow-worthy ideas from can1357/oh-my-pi onto our pi.ts adapter](https://github.com/MrMarble/dilna/issues/138), item **#1 ("Edit reliability / output-token economy")** — the first of the two items in that survey's "already have, but omp shows a meaningfully better version" section, and the survey's own #1 follow-up priority.

Grounded by reading the source directly, same method as `claude-agent-sdk-usage-limits.md`: the engine now lives in omp's Rust crate `crates/pi-edit/src/` (`modes/hashline/*`, `store.rs`, `patcher.rs`, `recovery.rs`, `block.rs`, and the N-API surface `crates/pi-natives/src/edit.rs`), plus `crates/pi-ast/src/block.rs`, the model-facing prompt `crates/pi-edit/prompts/hashline.md`, and the tool shell `packages/coding-agent/src/edit/`. On our side, the installed `@earendil-works/pi-coding-agent@0.84.3` dist and dilna's own `apps/server/src/agents/`.

**Purpose:** give the follow-up spec ticket the complete shape of what omp built and an honest map of what adopting it would touch. It states a recommendation; it decides nothing.

---

## 0. What dilna does today

`apps/server/src/agents/pi.ts:512` wires the stock tool: `createEditTool(opts.worktreePath)`. Its contract is `{ path, edits: [{ oldText, newText }] }` — exact-text replacement, matched against the **original** file, multiple disjoint edits per call, exact-then-fuzzy matching with smart-quote/dash/space normalization and BOM/CRLF preservation. That is the whole surface.

Two things worth knowing about how that tool reaches the model:

- **Its guidance lives only in `description`.** `createEditTool` is the `AgentTool`-returning wrapper; it drops the richer `editToolSystemPromptContribution` (`snippet` + four `guidelines` bullets) that `createEditToolDefinition` carries. And the bare `pi-agent-core` `Agent` dilna uses never reads `promptSnippet`/`promptGuidelines` anyway — only pi-coding-agent's own `AgentSession`/harness does. So the "keep `oldText` minimal but unique / merge nearby changes / don't pad" rules arrive as one prose paragraph in the tool `description`, or not at all.
- **Nothing special-cases edit-shaped args.** Server-side and shared-side, tool calls are opaque `input: unknown` passthrough. The only places the phrase "edit" carries meaning are `packages/shared/src/tools.ts` (`TOOL_NAMES`, `TOOL_ARG_KEYS.edit = "path"`) and `confinement.ts:28`'s `PATH_TOOLS` name set.

---

## 1. What the hashline engine actually is

A **line-anchored, content-hashed patch language**. Instead of quoting the text you want to replace, you name *lines* of a snapshot the agent has already been shown, and prove which snapshot you mean with a 4-hex tag.

```
[src/example.ts#1A2B]
PUT 4.=4:
+const value = 2;
```

Four load-bearing pieces:

### 1.1 The snapshot tag

`store.rs::file_hash` — and it is genuinely this simple to reimplement:

```rust
// strip BOM, normalize to LF, then trim trailing ' '/'\t'/'\r' per line
format!("{:04X}", xxh32(normalized.as_bytes(), 0) & 0xffff)
```

- Hash input is the **whole normalized file text**. Not the path, not line ranges.
- **XXH32** (seed 0), low 16 bits, uppercase 4-hex.
- Ground-truth vectors from omp's own tests: `file_hash("a \n b\t\r\nc") == "80BA"`, `file_hash("hello\n") == "5BF9"`, `file_hash("") == "5D05"`. A port must reproduce these byte-for-byte — they are the compatibility contract.
- Trailing-whitespace-only differences collapse to the same tag; interior/leading whitespace still counts.

**Verified reproducible.** A from-scratch XXH32 + this normalization in plain dependency-free JS reproduces all three omp test vectors exactly (`80BA` / `5BF9` / `5D05`) — so the tag compatibility contract is satisfiable in TypeScript without a hashing dependency. Note an implementation gotcha: Node's `crypto` has no xxhash digest, and dilna has no xxhash package, so this is a ~40-line hand-roll (or one small dep).

A separate `payload_hash(text) = xxh64(bytes, 0)` exists solely for the no-op loop guard.

### 1.2 The tag is enforced, and staleness is *recovered*, not just rejected

This is the heart of the feature and the part the survey's "stale-anchor rejection" phrasing undersells. On apply, omp hashes the live file and compares to the tag:

- **Live matches** → apply normally.
- **Tag unknown to the session** → hard error: *"hash #{tag} is not from this session."* plus the real current hash and ±2 lines of anchored context.
- **Tag was this session's but the file moved on** → `recovery.rs::try_recover` attempts a *provably unique* remap, and only applies it if **all** of:
  1. a stored snapshot for that exact tag exists;
  2. a **uniform-offset**, neighbour-consistent line remap exists (`pi_diff::line_runs_str` across old/new, every remapped anchor sharing one offset);
  3. the **enclosing tree-sitter construct identity** (node `kind` + trimmed opening row) is identical at the first and last anchor of each edit — this is what rejects a uniform offset landing in an identically-shaped sibling block that all positional checks would pass;
  4. the remapped edits apply cleanly and actually change bytes.

  Otherwise → the mismatch error. A successful recovery is *reported* (`RECOVERY_EXTERNAL_WARNING` / `RECOVERY_SESSION_CHAIN_WARNING` / `RECOVERY_LINE_REMAP_WARNING`), never silent.

So: a stale anchor can never corrupt a file, and a large class of stale anchors self-heal instead of costing a round trip.

### 1.3 The patch language

| Form | Effect |
|---|---|
| `PUT N.=M:` + `+TEXT` rows | Replace inclusive original lines `N..M`. |
| `PUT N*:` + body | Replace the tree-sitter block beginning at line `N`. |
| `PUT <N:` / `PUT >N:` | Insert before / after line `N`; `PUT <1:` = head. |
| `PUT >$:` | Append at tail. |
| `PUT >N*:` | Insert after block `N` (lowers to `PUT >N:` with a warning if unresolvable). |
| `CUT N.=M` / `CUT N*` | Delete and capture into a register. |
| `PUT <N @name` / `PUT N.=M @name` | Paste a register into a gap / over a range. |
| `REM` / `MV DEST` | Delete / move the section file. |

Body rows are **`+TEXT` final content, never a unified-diff pair** — `-old` rows are rejected or warned away, which is precisely how the "retry loop on bad diffs" disappears. **All line numbers are original-snapshot numbers, never shifted by earlier hunks**; application buckets edits by original anchor and applies in descending order, so anchor drift is structurally impossible within a call.

Registers: anonymous (batch-local) and named (`@name`, session-persistent, committed only after the write lands) — this is what lets a `CUT` in one section feed a `PUT` paste in a later one, i.e. structured moves between files.

### 1.4 Supporting machinery

- **Seen-line enforcement.** Snapshots record which lines `read`/`grep` actually showed; an edit anchoring outside that set is rejected *and* the error inlines up to 40 of the offending lines (~512 cols each) while adding them to the seen set — so a straight retry succeeds. This is the anti-hallucination mechanism: you cannot edit lines you were never shown.
- **Block resolution (`N*`).** `pi-ast::block.rs` — point-query the tree-sitter parse at the line's first content char (one column wide, deliberately), climb to the outermost named node still starting on that row, reject `ERROR` subtrees. ~60 grammars. Markdown headings resolve through deeper subsections to the next equal-or-higher heading.
- **Validation limits.** `MAX_EXPANDED_RANGE_LINES = 100_000`; overlap rejection with same-path section merge; a no-op guard that escalates to a hard stop after 3 byte-identical no-op payloads.
- **Streaming preview.** A native `EditSession` pumps argument deltas and renders a read-only numbered diff, silently dropping the trailing incomplete op / unresolved blocks / empty pastes rather than showing transient states as failures.
- **Purity.** The Rust engine never writes files — the host does. But it is **not stateless**: the `EditStore` (snapshots, seen-lines, clipboard, no-op counters) persists across calls and is mutated by apply. Treat it as `(arg snapshot, files, &mut EditStore) -> StagedFile[]`, not a pure `bytes × patch -> bytes`.

### 1.5 Their benchmark numbers are marketing

The survey quotes "Grok Code Fast 6.7% → 68.3%", "+5pp over `str_replace`", "−61% output tokens". **None of that is reproducible from the repo.** It is a README table linking to a blog post; grep finds no result file, fixture, or script output bearing those figures. The only comparison machinery that exists is `scripts/edit-benchmark.py` (+ `edit_benchmark_common.py`), which is parameterized by `PI_EDIT_VARIANT` (`hashline` / `replace` / `patch` / `apply_patch` / `vim`) and *could* run an apples-to-apples hashline-vs-str_replace test — but it is **one Rust task**, `DEFAULT_MAX_TURNS = 5`, and **no results are committed**. `packages/typescript-edit-benchmark/all_models_results.json` is a different roster (deepseek/glm/haiku/kimi/minimax) with no str_replace column. `bench/muse-hashline.ts` measures latency and payload bytes only.

**Implication for the spec: do not inherit the numbers.** If we want an evidence base we have to build our own small A/B — which is cheap to do here, because the contract is variant-switchable by construction.

---

## 2. Adopting it: what it actually costs dilna

The engine is ~a dozen Rust modules plus a tree-sitter block resolver plus the store. Three adoption shapes, in ascending cost:

**A. Vendor the Rust crates.** `pi-edit` + `pi-ast` + `pi-diff` behind N-API. Highest fidelity, and the only shape that gets true `N*` block resolution for free. But it means adding a Rust toolchain and native build artifacts to dilna's runtime image, a second language in the server, and a cross-language wire boundary to maintain against a sibling fork that is not our dependency. **ADR-0020's framing (omp is a fork, not upstream — nothing is obtainable by bumping a version) applies in full.**

**B. Reimplement in TypeScript, scoped down.** The genuinely portable core is small and self-contained: the `file_hash` normalization + XXH32-low-16 (reproducible against the three test vectors), the section/hunk parser, descending-order application over original anchors, register handling, and a *tag-match-or-refuse* check. Skipping everything else. Deferrable without breaking the model: `N*` block anchoring (needs a tree-sitter dependency or falls back to explicit ranges), seen-line enforcement, and recovery. `pi.ts` already ships one precedented dilna-authored tool this way — `createWebFetchTool` is described in ADR-0026 as a "scoped-down port of oh-my-pi's fetch pipeline". **This is the recommended shape.**

**C. Steal only the cheap half.** Keep the `edits[].oldText` contract but add a snapshot tag the model must echo, plus tag-mismatch refusal. Gets the "a stale file can't be silently corrupted" guarantee at a fraction of the cost, but keeps most of the output-token and retry-loop upside on the table, since the model is still quoting text.

### Blast radius (identical for all three shapes)

The survey's own scoping instinct — "so each stays grounded against **our** `pi.ts` adapter rather than omp wholesale" — is worth heeding, because the list is longer than it looks:

| Concern | File | Why it breaks if missed |
|---|---|---|
| Tool construction | `pi.ts:44,512` | swap the factory |
| **Confinement** | `confinement.ts:28,52,125–157` | `PATH_TOOLS` is a **name denylist** that reads a flat `args.path`. Rename the tool or move the path field (e.g. a multi-file patch carrying paths inside sections) and the hook **fails open — no worktree boundary at all**. This is the single sharpest edge in the port. |
| Wire vocabulary | `packages/shared/src/tools.ts` (`TOOL_NAMES`, `TOOL_ARG_KEYS.edit`) | one edit arg, one subject — a multi-file patch has no single `path` |
| Re-seed round-trip | `pi.ts` `piRoundToDilnaMessage` / `dilnaMessagesToInitialState` | persisted `input` must survive replay byte-for-byte |
| Read-only subagent invariant | `taskTool.ts:169–174`, `taskTool.test.ts:130–142` | ADR-0034's "read-only, enforced by tool omission"; the new tool must not leak into the child set |
| Web rendering | `apps/web/src/lib/tool-meta.ts:77–81` | falls back to wrench + raw name otherwise |
| Web diff panes | `apps/web/src/components/ChatShell.tsx:1305–1312,1364–1370` | **currently dead code** — it sniffs Claude-era `part.tool === "Edit"` / `old_string`, which pi's `edit` never emits. Either rewrite for the new shape or delete. |
| Tests | `confinement.test.ts:128,184–187`; `pi.test.ts`; `tools.test.ts:78–90` | `it.each` name lists silently stop covering a renamed tool |

Unchanged, usefully: `transcript.ts` (generic JSON dump), `sessions/diff.ts` + the Changed-files panel (git-derived, not tool-derived), and `worktreeSandbox.ts` (governs bash only — a Node-`fs` edit tool is not covered by bwrap and never was; `confinement.ts` is its only boundary).

**No ADR covers the edit contract.** ADR-0020 Finding #2 decided only that confinement is dilna's problem (leaving the wrap-vs-reimplement question to the now-closed #95); it says nothing about `oldText`/`newText`. Per CLAUDE.md:7 a new ADR is required, and the prompt-guidance finding above (`createEditTool` drops the guidelines, the bare `Agent` ignores them) is exactly the kind of non-obvious fact that ADR should record.

---

## 3. Recommendation

**Take shape B, staged.** Concretely, in order:

1. **Tag + refusal first.** Add snapshot minting (the port of `file_hash` above, pinned to the three test vectors — already confirmed to reproduce) and a `Tag | Refuse` apply path, *before* changing the input shape. This alone delivers the "stale file cannot be silently corrupted" property — the survey's headline claim — and is independently testable.
2. **Then the patch language, scoped.** `PUT N.=M:` / `PUT <N:` / `PUT >N:` / `PUT >$:` / `CUT` / `REM` / `MV`, original-anchor numbering, `+TEXT` bodies. Skip `N*` block anchors in v1 (tree-sitter dependency) and skip seen-line enforcement and recovery — additive later without a contract change.
3. **Then decide on evidence, not omp's README.** Use the variant-switchable contract to run our own small A/B on real dilna sessions before committing to the full language.

Two guardrails for the spec ticket: **the tool name and the `path` arg must stay exactly where confinement expects them** (or `PATH_TOOLS` must change in the same commit — this is worth an explicit test), and **the guidelines currently in the stock `description` must be rewritten for the new contract**, since neither pi mechanism will deliver them.

Reason to be cautious about shape A: it buys true block anchoring and streaming preview at the price of a Rust toolchain in the runtime image and a fork-shaped dependency. Worth revisiting *after* the TS core proves the round-trip win in dilna's own numbers.
