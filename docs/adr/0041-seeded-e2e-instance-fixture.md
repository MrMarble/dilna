# A seeded second instance for the e2e loaded state

## Context

`apps/web/e2e/` had 20 tests across two specs, all against a single fixture:
the **empty instance**. `shell.spec.ts` and `clone-repo.spec.ts` assert that the
SPA mounts, the empty state renders, the sidebar shows its zero state, `New
session` is disabled, Metrics/Skills/Settings resolve, and the clone dialog
validates its form. That is a good regression canary for the shell — and it is
the whole of what the suite covers.

Issue #224 named the gap in its own comment: *"No actual clone. Needs network
and a live git remote; would make the suite slow and flaky. This means
repo-cloned → session-created → chat, i.e. most of the interaction complexity,
is still uncovered."* Everything past the empty state — the branch almost all
of a user's time is spent in — had no e2e coverage at all.

The constraint that produced the empty-only fixture was #205's: *"no e2e
coverage available in this environment (playwright needs root)"*. ADR-0037
made that obsolete by putting Chromium's shared libraries in the runtime
image, and #224 built the real-stack runner (`e2e/server.mjs`: `mkdtemp` data
dir, `process.execPath` to escape the mise shim's env injection, the built SPA
served by the real server). The runner was in place; only the *fixture* was
missing. Issue #238 asked for it, and asked for the choice to be recorded
explicitly, because it changes what the suite can assert everywhere, not just
in one spec.

## Decision

**A second, seeded instance runs alongside the empty one.** Each is a separate
server process with its own `mkdtemp` data dir, started by Playwright's
`webServer` **array**, and each Playwright project's `testMatch` routes specs
to the instance they need:

| Project | Instance | Specs |
|---|---|---|
| `empty` | nothing cloned | `shell.spec.ts`, `clone-repo.spec.ts` |
| `seeded` | one repo cloned, one Session | `loaded-state.spec.ts` |

**Seeding goes through the server's own HTTP API**, not by writing rows into
the scratch SQLite file. `e2e/server.mjs --seed` waits for `/api/health`,
`POST`s a local bare repo's path to `/api/repos`, then `POST`s a Session for
it, and only then lets the port become observable as Playwright's
`webServer.url` probe — so no spec can race a half-seeded instance.

**The git remote is a bare repository created inside the scratch data dir**,
never a network remote. `git clone` accepts a local path as a URL, so the bare
repo is an entirely ordinary remote to the server; it just can't be reached
from another machine. The offline/no-flake property #224 was protecting is
untouched, and because the remote lives under `DILNA_DATA_DIR`, teardown is
already covered by that directory's removal.

**`e2e/**` is now type-checked**, as a third project in `apps/web`'s
`typecheck` script (`tsconfig.e2e.json`), alongside the app and the service
worker.

## Why not the alternatives

- **Seeding the one existing instance in place, and having the empty-state
  specs cope.** Rejected: `shell.spec.ts`'s zero-state assertions are the
  reason the empty fixture exists, and "no repos cloned" is not a state you can
  fake on an instance that has a repo. The alternative — a spec that deletes
  the seeded repo to get back to empty — makes the canaries depend on
  destruction order in a suite that shares one server and one DB.
- **Writing the `repos`/`sessions` rows directly into the scratch SQLite
  file.** This is the approach the issue floats first, and it is the one to
  avoid. A Session is only real if
  `<dataDir>/worktrees/<slug>/<id>` is a genuine git worktree of
  `<dataDir>/repos/<slug>`: `GET /:id/changed-files`, `/:id/commits` and the
  `ContextPanel` all shell out to git against that path, and boot's
  `repos.ensureAllGitDefaults()` shells out against the repo path. A
  hand-written row pointing at a directory that isn't a worktree produces a
  fixture that *looks* seeded and fails at the first assertion. It also means
  reimplementing `RepoManager.clone`'s bare-clone + `remote.origin.fetch`
  refspec + `info/exclude` repair, and `SessionManager.create`'s
  `git worktree add -b` — a second implementation of the very code under test.
  Going through the API costs one HTTP round trip and reuses the real paths.
- **Importing `createServerContext()` from the built server bundle** rather
  than driving the API, to seed in-process. Rejected: `dist/index.js` starts
  an HTTP server as a side effect of import (and primes providers/VAPID keys,
  and calls `getDb()`), so importing it from a fixture script means either a
  second server on a second port or a refactor of `index.ts` to separate
  "build the app" from "listen". The API-driven seeder needs neither, and it
  seeds the instance the browser will actually talk to.
- **Seeding from the spec side in a `globalSetup` or `beforeAll`.** Rejected:
  the seeded state has to exist before *any* spec's fixture resolution runs,
  and a `beforeAll` per spec file would let the first-arriving spec observe an
  unseeded instance. Doing it in `server.mjs` before the port is considered up
  makes "the instance is seeded" an invariant of starting a run, not a step
  that can be reordered.
- **One instance with a `?seed=` query parameter per spec.** Rejected: the
  server has no such notion, and adding one to the product for the test
  suite's convenience inverts the dependency.
- **Not type-checking `e2e/**`** (the status quo). Rejected once this change
  put real typed code — page objects, a fixture with a resolved-shape return
  value, config with two web servers — in a directory no TypeScript project
  included. Until now a renamed prop or a stale locator signature in a page
  object failed at play time, if at all.

## Consequences

The suite goes from 20 to 29 tests. The nine new ones are the band #224 named:
the sidebar in loaded state with its Session submenu, a deep link resolving to
`/<slug>/<id>` and rendering chat + composer, `New session` enabled, the
header's breadcrumb/agent badge, and the `ContextPanel` — its changed-files
list, its commit list, its repository/session facts, its collapse/reopen round
trip, and its survival of a page reload. `ContextPanel.tsx` (562 LOC, no tests)
now has a real interface to be tested through: "opening the panel shows the
repo's files", not a jsdom assertion on rendering incidentals.

**The fixture immediately found a latent bug in the existing page object.**
`SidebarObject.repo()` matched `/^slug\b/`, which was correct only on the empty
instance: the repo row's accessible name is `"TypeScript seeded-repo main"` —
the primary-language icon's `img` alt text precedes the slug — and repo stats
arrive after the first paint, so `/^slug/` matched on the empty instance for
the wrong reason and broke the moment a repo existed. It is now `/slug/` with
the trailing `\b` that still keeps `my-repo` from matching `my-repo-2`. This is
the class of defect the issue predicted: an assertion that passes because the
fixture it runs against is degenerate.

The same "one server, one DB" hazard that `workers: 1` exists to manage is now
per-instance rather than global, so `loaded-state.spec.ts` is read-only by
convention, documented in the spec and in the `seeded` fixture: no spec may
create or delete a Session, because the sidebar every later spec sees would
change under it. A spec that needs to mutate Session state wants its own
instance, and the config's project/`testMatch` split is where that goes.

`PLAYWRIGHT_BASE_URL` (point the run at an instance you already have) collapses
both projects onto one URL, so a seeded spec against a non-seeded hand-rolled
instance fails its fixture lookup with a message that points at the cause.

Adding coverage for `ChatHeader.tsx` (209 LOC), `SkillsPage.tsx` (374 LOC) and
`useWebPush.ts` remains open, as #238 sets out. `ChatHeader` is now partly
covered by the seeded header spec. `useWebPush` is deliberately not attempted
here: `DILNA_DISABLE_WEB_PUSH=1` is set by the runner and the path needs
notification permission plus a push subscription, so it stays a unit-test
problem rather than being forced through a browser it can't exercise.
