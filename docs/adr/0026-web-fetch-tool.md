# Web fetch tool: scoped-down port of oh-my-pi's fetch pipeline

## Context

dilna's pi Sessions (ADR-0020) had no dedicated way to read web content. The
only route was `curl` through sandboxed bash — which works (the sandbox
network policy allows all domains; see `ensureSandboxInitialized` in
`pi.ts`), but returns raw HTML: tens of thousands of tokens of markup, nav,
and script for a page whose useful content is a few hundred tokens of prose.
Issue #138's survey of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)
("omp", a sibling fork of the pi lineage — not upstream of the
`@earendil-works/pi-*` packages dilna pins, so nothing here is obtainable by
a dependency bump) identified its web surface as net-new for dilna: a `fetch`
pipeline that goes to unusual lengths to hand the model *markdown*, not
markup.

omp's full pipeline (read directly from
`packages/coding-agent/src/tools/fetch.ts` and `src/web/`): URL
normalization → ~80 site-specific scrapers (GitHub/npm/PyPI/arXiv/…) →
robust page load (UA ladder against bot walls, 429 Retry-After retry,
charset decode, streaming byte cap) → binary dispatch (PDF/DOCX via markit,
archives, SQLite, notebooks, inline images) → markdown-first strategies for
HTML (`<link rel=alternate>` discovery, `.md` suffix mirrors, content
negotiation, feed rendering) → a six-backend reader chain (native Rust
converter, trafilatura, lynx, Parallel, Firecrawl, Jina) gated on output
quality → llms.txt fallback. Plus a separate 23-provider `web_search` tool.

## Decision

Add a `fetch` tool to every pi Session's tool set
(`apps/server/src/agents/webFetchTool.ts`, registered in `startPi`), porting
the parts of omp's pipeline that most improve what the model reads while
staying dependency-light:

- **URL normalization** — scheme-less → `https://`, collapsed-scheme repair
  (`https:/host` → `https://host`), non-http(s) schemes rejected.
- **Robust page loading** — omp's exact user-agent ladder (curl → generic
  bot → browser) retried on bot-wall heuristics, one bounded-`Retry-After`
  429 retry, redirect following, charset-aware decode (header then
  `<meta charset>` sniff), and a 5MB streaming byte cap.
- **Markdown-first strategies for HTML**, in omp's order: `.md` suffix
  (llms.txt per-page-mirror convention) → content negotiation
  (`Accept: text/markdown`) → local HTML→markdown rendering → llms.txt
  endpoint probes when rendering fails omp's quality gate (JS-gated or
  navigation-heavy output) → raw HTML as last resort. Side-requests get a
  5s budget each so misses stay cheap.
- **Content-type dispatch** — JSON pretty-printed, text/markdown passed
  through, binary payloads (NUL/replacement-char sniff) reported as a
  one-line notice pointing at bash `curl` for the actual bytes.
- **Output economy** — blank-run collapsing, 50K-char cap (the read tool's
  truncation neighborhood), and a `Method:` header so the model can tell
  which strategy produced the content and retry with `raw: true` if a
  rendering looks wrong.

HTML→markdown uses `turndown` (new dependency) — the same engine omp's own
`htmlToBasicMarkdown` fallback uses; omp's preferred converter lives in its
Rust N-API crates, which #138 already ruled out vendoring for a first pass.

The tool runs in the server process, not sandboxed bash. This grants no new
capability: the sandbox's network policy is already `allowedDomains: ["*"]`,
so agent-driven `curl` can reach anything this tool can (including
localhost — an agent can already hit dilna's own API from bash). The tool
exists for token economy, not access.

Deliberately **not** ported in v1 (second-wave candidates per #138's own
slicing): the site-specific scrapers, `web_search` and its providers, remote
reader backends (Jina/Firecrawl/Parallel/trafilatura/lynx — all need API
keys or installed binaries), RSS/Atom feed rendering, `<link rel=alternate>`
discovery, binary rendering (PDF/archives/SQLite/notebooks/images), and
omp's `:N-M` line-selector syntax on URLs. Orchestrator Sessions (ADR-0021)
don't get the tool — their surface is deliberately dilna-internals only.

## Consequences

- Agents fetch docs/issues/changelogs directly and get markdown at a bounded
  token cost, instead of raw HTML through bash or refusing for lack of a
  tool.
- Every HTML fetch can issue up to two cheap side-requests (`.md` probe,
  content negotiation) before rendering locally — omp's tradeoff, accepted
  for the quality win when a markdown mirror exists.
- `turndown` is a new production dependency of `@dilna/server`.
- The pipeline is exported piecewise (`loadPage`, `renderUrl`,
  `htmlToMarkdown`, …) with an injectable `fetch`, so tests run fully
  offline and later waves (search, scrapers, richer `read` URL handling)
  can build on the same primitives.
