# Replace the manager singletons with constructor injection

## Context

`RepoManager` and `SessionManager` were module-level singletons:

```ts
export const repoManager = new RepoManager();   // repos/manager.ts
export const sessionManager = new SessionManager(); // sessions/manager.ts
```

Both had no-arg constructors and reached for ambient state (`getDb()`,
`getDataDir()`) from inside their method bodies. Every consumer —
`routes/{repos,sessions,skills,stream}.ts`, `agents/orchestratorTools.ts`,
`index.ts`, and eight test files — imported the instance directly. Issue #150
catalogued two costs.

**Import-time construction fought test setup.** A singleton is constructed
when its module is first imported, which is before any test has run its
`beforeAll`. Tests isolate themselves by pointing `DILNA_DATA_DIR` at a
`mkdtemp` scratch directory, so anything a constructor reads from the
environment is read too early — against the real `data/` dev state. The
codebase had already absorbed one workaround for exactly this:
`SessionManager.hydrateRateLimits` was deferred to first read, its doc comment
saying so outright ("Lazy … because the singleton is constructed at module
import time, before tests get to point `DILNA_DATA_DIR` at their scratch
directory"). That workaround leaked into the test suite as an *ordering*
constraint: `manager.test.ts`'s restart test only passed because no earlier
test in the file had happened to call `getRateLimits()` first, a condition
invisible from any of the tests it constrained.

**A real import cycle.** After the #148 hardening pass, `repos/manager.ts`
imported `sessionManager` (so `RepoManager.delete` could cascade-delete a
Repo's Sessions) while `sessions/manager.ts` imported `repoManager` (to
resolve a Session's Repo). This was safe only by convention — both sides
deferred the reference into async method bodies, so neither observed a
half-initialized module during evaluation. Nothing enforced that. Hoisting
either read to module scope would have broken it at a distance, with a
`undefined is not an object` at boot rather than anything pointing back here.

## Decision

Both managers take their dependencies as constructor parameters, and are
constructed exactly once in a composition root.

- `RepoManager` takes `{ db, dataDir }`.
- `SessionManager` takes `{ db, repos }`.
- `apps/server/src/container.ts` exposes `createServerContext()`, which builds
  the pair, wires them together, and returns `{ repos, sessions }`. `db` and
  `dataDir` are optional parameters defaulting to `getDb()`/`getDataDir()`, so
  a test can build an isolated pair without touching the environment.
- The four route modules that used a manager become factories —
  `createReposRoute({ repos })`, `createSessionsRoute({ sessions, repos })`,
  `createSkillsRoute({ repos })`, `createStreamRoute({ sessions })` — mirroring
  the `createOrchestratorTools(deps)` factory this codebase already had.
- `orchestratorTools.ts`'s one remaining direct reach (`repoManager.list()`)
  becomes a `listRepos` entry on the existing `OrchestratorDeps`, which is
  where every other dependency of that module already lived.

`getDb()` itself stays a process-wide accessor, and the free-function modules
around these managers (`messageStore`, `worktree`, `usageAccounting`,
`sessionStore`, `archive`, …) keep calling it directly. ADR-0027 decided that
deliberately: those modules hold no instance state, so injecting a handle
would add construction ceremony for nothing. This ADR narrows that reasoning
rather than reversing it — the two *managers* are precisely the things that do
own lifetime-scoped mutable state (`active`, `starting`, `events`, `turns`,
`rateLimits`) and therefore benefit from being constructed rather than
imported.

### Breaking the cycle

`repos/manager.ts` no longer imports `sessions/manager.ts` at all. It declares
the slice it needs:

```ts
export interface SessionCascade {
	listByRepo(repoId: string): Promise<{ id: string }[]>;
	delete(id: string): Promise<void>;
}
```

The real `SessionManager` satisfies this structurally. The remaining edge is
one-directional and type-only (`sessions/manager.ts` imports `RepoManager` as
a type).

Because `SessionManager` needs a `RepoManager` to construct, the two can't
both be complete at `new` time, so the Repo→Session direction is closed in a
second step via `repos.setSessions(sessions)`. That asymmetry is real, not
incidental: deleting a Repo must delete its Sessions, and creating a Session
must resolve its Repo. Something has to be finished after the fact. Doing it
in one explicit place beats two modules importing each other's singleton, and
`RepoManager.delete` throws a named error if it was never wired, so a missed
call fails loudly instead of silently orphaning Sessions.

## Consequences

`hydrateRateLimits` moves into the constructor, and the restart test now
constructs a *fresh* manager over an already-seeded row — actually simulating
a restart instead of depending on file-level test ordering.

The validation-only route tests (`repos.test.ts`, `sessions.test.ts`,
`skills.test.ts`) now pass `{} as never` managers, which documents in the code
that zod rejects those requests before any handler runs. `orchestratorTools.
test.ts` drops a whole-module `vi.mock("../repos/manager")` in favour of an
ordinary stub function. `container.test.ts` drives the delete cascade with an
object literal — no `SessionManager`, no cloned Repo, no worktree.

Cost: the composition root is a thing that has to exist and be kept in order,
and route modules gained a level of indentation. Eight test files grew a
`beforeAll` that builds a context, since they can no longer import a
ready-made instance.

All 719 existing tests pass unchanged in behaviour; 5 new tests cover the
container itself. No HTTP surface, event contract, or DB schema changed.

Out of scope: `agents/pi.ts` still imports `sessions/manager` for its
persistence bridge, and `getDb()` remains ambient for the free-function
modules per ADR-0027. Neither is a cycle, and neither blocked this change.
