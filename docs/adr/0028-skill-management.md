# Skills: global install, per-Repo enablement, files on disk

## Context

[Issue #60](https://github.com/MrMarble/dilna/issues/60) covers agent skills —
`SKILL.md`-style reusable procedures, loaded only when relevant (progressive
disclosure: list metadata cheaply, load full content on demand). The issue and
its research comment identify three provenance sources: agent-discovered,
repo-local, and registry-installed.

This ADR covers **only the management half**: a user finding, installing,
enabling and disabling skills by hand. Agent-authored skill creation (the
issue's original framing) is deliberately deferred — it needs an approval gate,
which needs a notification/prompt system dilna still doesn't have (the same
blocker ADR-0018 hit for repo memory).

Two facts were established empirically against the live services before
designing, both of which constrain the shape:

- **A skill is a folder, not a file.** `mattpocock/skills/tdd` is `SKILL.md`
  plus `tests.md`, `mocking.md` and `agents/openai.yaml`, and its SKILL.md
  links to those siblings by relative path. Storing only the SKILL.md installs
  a skill with dangling links.
- **skills.sh's documented `/api/v1/*` API is unusable for self-hosted dilna.**
  It authenticates with a *Vercel OIDC token*, minted per-request for apps
  deployed on Vercel; every `/api/v1/*` endpoint returns 401
  `authentication_required` without one. This rules out
  `/api/v1/skills/{source}/{slug}`, which would otherwise be ideal (it returns
  the whole file tree inline as `{path, contents}[]`). The *legacy*
  `/api/search` endpoint — the one `vercel-labs/skills`' own CLI calls — needs
  no auth.

A third finding corrects the issue's research comment: `loadSkills`/
`loadSourcedSkills`/`formatSkillInvocation` **are** on `@earendil-works/pi-agent-core`'s
public export surface as of 0.84.3 (`dist/index.d.ts` line 13 is
`export * from "./harness/skills.ts"`). No deep import into `dist/` and no
upstream ask are needed; the comment's suggested step 2 is moot.

## Decision

- **Install is global; enablement is per-Repo.** One copy of a skill's files
  exists on disk no matter how many Repos use it. `skills` is the global
  catalog (keyed by the registry-stable `{source}/{slug}`), and `repo_skills`
  is a `(skillId, repoId)` join whose *presence* means enabled. This departs
  from the issue's original per-Repo framing, on the grounds that a
  registry-installed skill like `tdd` is general-purpose — per-Repo-only
  storage would mean re-downloading and re-storing it once per Repo.
- **Files live on disk** at `<data>/skills/<id>/`, not in a DB blob. Two
  reasons: a skill is a *tree*, and `loadSkills` — the loader dilna hands
  these to — takes directory paths. A blob store would mean materializing a
  temp directory on every session start purely to satisfy the loader.
  **This is a deliberate departure from ADR-0018's "a DB row, not a file"**
  for repo memory: memory is one bounded string with no internal structure,
  where a DB row was strictly simpler; a skill is a folder whose parts
  reference each other by relative path.
- **Disabled everywhere by default.** A freshly installed skill is off for
  every Repo until explicitly enabled. Third-party content lands straight in
  an Agent's context, so "off until asked for" is the safe default, and there
  is no sensible "which Repos?" to guess at install time.
- **Install by fetching the source repo's tarball**, not via the registry API
  (which is unreachable, above) and not via the `skills` package (CLI-only —
  `bin` and no `exports`/`main`, so nothing importable). This is also exactly
  what `npx skills add` does. Hostile-archive bounds mirror the ones
  `vercel-labs/skills` applies in its own `download-source.ts`: 10MB download,
  25MB extracted, 1000 files, plus rejection of absolute paths and `..`
  traversal, and of every entry type except regular files (no symlinks).
- **Search via the unauthenticated legacy `/api/search`**, reimplemented
  server-side as a thin fetch. Registry failures return `[]` rather than
  erroring: search is a discovery aid layered over "paste a URL", and an
  outage should degrade the page, not block installing by URL.
- **Progressive disclosure via a `read_skill` tool.** Only each enabled
  skill's `name`/`description` goes into the system prompt (one line each);
  the body is fetched on demand by name. A Repo with no skills enabled gets
  no prompt section at all, so the feature costs nothing where it's unused.
- **`store.ts` is the single write path**, mirroring `repos/memory.ts`'s
  choke-point shape, so a future approval or secret-scanning gate can be added
  at `installSkill` without touching route or agent wiring.

## Why not the alternatives

- **Per-Repo installs** (the issue's original scope): would duplicate a
  general-purpose skill's files once per Repo and force a reinstall per Repo.
  The global-catalog/per-Repo-join split gets the same user-visible behaviour
  ("this skill is on for this repo") without the duplication.
- **Skill content in a DB blob** (consistent with ADR-0018): rejected above —
  it fights both the folder shape and `loadSkills`' directory-based API.
- **A boolean `enabled` column instead of a join row**: would need a
  default-value answer for every (skill, Repo) pair that didn't exist when the
  skill was installed. Row-presence-means-enabled has no such gap.
- **Depending on the `skills` npm package**: it exposes only a `bin`, and its
  install logic is coupled to `@clack/prompts` and `process.cwd()`. There is
  nothing to import for a server-driven flow.
- **A `tar` dependency for extraction**: the format is 512-byte headers plus
  padded content; hand-rolling it against `node:zlib` keeps the
  hostile-archive checks explicit and in-repo rather than trusting a library's
  defaults, for ~80 lines.
- **Three-state visibility** (OpenClaw's `includeInRuntimeRegistry`/
  `includeInAvailableSkillsPrompt`/`userInvocable`): deferred in favour of the
  simple enabled/disabled pair, matching this codebase's "ship the simpler
  primitive, revisit if usage proves it's not enough" pattern (ADR-0018's cap,
  ADR-0023's budget-only trigger).

## Consequences

- New tables `skills` and `repo_skills`; `RepoManager.delete` now also drops
  the Repo's enablement rows (the skills themselves stay installed).
- New `<data>/skills/` directory alongside `worktrees/` and `db/`. It is not
  inside any Worktree, so ADR-0010's sandbox confinement means an agent cannot
  read or write the skill store through its own file tools — skills reach it
  only via the system prompt listing and `read_skill`.
- `pi.ts` gains a skills prompt section and a `read_skill` tool. Both no-op
  cleanly when a Repo has nothing enabled.
- **No secret scanning yet.** The issue's research flagged
  `evaluateSkillInstallPolicy`-style scanning as a hard requirement for
  registry installs. It isn't implemented here; `installSkill` is the single
  choke point where it belongs. skills.sh's audit endpoint
  (`/api/v1/skills/audit/{id}`) is notably *unauthenticated* and returns
  partner pass/warn/fail verdicts, so surfacing those badges at install time
  is the cheapest first step — left for a follow-up.
- Skill *updates* are reinstall-only (installing again replaces the folder
  wholesale). There is no version pinning or update notification; the registry
  exposes a content `hash` that a future change could use for staleness
  detection.
