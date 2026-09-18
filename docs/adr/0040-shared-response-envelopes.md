# Shared response envelopes, and a `requireRepo` middleware

## Context

ADR-0039 moved the HTTP API's **request** bodies into `packages/shared` and
deliberately stopped there, under the rule *"schema what crosses the wire
inbound, type what goes out"*. That was the right call for validation — the
server never parses its own responses from untrusted input, so a runtime
schema for them would be cost without benefit.

But "type what goes out" left *where* that type lives unanswered, and in
practice it was declared twice: once as a route-local alias on the server
(`type ListResponse = { repos: Repo[] }`, private to each route file), and
once as a hand-written generic at the web call site (`request<{ repos:
Repo[] }>`). Six such aliases existed on the server and 42 inline generics in
`apps/web/src/api/client.ts`. Neither side referenced the other, so the
compiler could not see that the two were meant to be the same contract.

This is exactly the gap ADR-0039 closed for requests, where
`LlmConfig`/`GetConfigResponse` had already silently drifted on `api: string`
vs a four-literal union — left undone for responses. Issue #231 measured the
cost: `api/client.ts` changed in 3 of the last 12 feat/fix PRs, every one a
hand-edit a shared envelope would have made unnecessary.

**It had already produced three live drifts**, all of the same kind — the
server sends a field the client's type omits, so the data arrives and is
invisible:

| Endpoint | Server sends | Client typed |
|---|---|---|
| `POST /api/sessions` | `{ session, contextUsage }` | `{ session }` |
| `POST /api/sessions/orchestrator` | `{ session, contextUsage }` | `{ session }` |
| `GET /api/push/key` | `+ subscriptions, lastSuccessAt` | `{ publicKey, configured }` |

The push one is the most telling: that route's own doc comment calls
`subscriptions`/`lastSuccessAt` the first thing to check when notifications
aren't arriving, and the server has a test asserting it serves them — but no
web consumer could see the fields, because `useWebPush.ts` destructures a type
that never declared them. The Sessions one had drifted *within a single file*:
`sessions.get` declared `contextUsage`, while `sessions.create` beside it did
not, for the same server type.

Separately, the domain-error → `HTTPException` translation repeated across
route files, most visibly a `repo not found` 404 lookup appearing 4× in
`repos.ts` and 2× in `skills.ts`. `requireSession` (issue #204) had already
solved this shape for Sessions; the equivalent seam did not exist for Repos.

## Decision

**Response envelopes live in `packages/shared/src/apiResponses.ts`**, imported
by both the route handler and the client call site — the same treatment
requests got in ADR-0039.

They are **plain types, not Zod schemas**. ADR-0039's rule is unchanged: these
are outbound, so what is wanted is a compile-time link between the two sides,
not runtime parsing in the browser. The link only exists if both sides *name*
the type rather than restating its shape, so route handlers annotate
(`const body: RepoResponse = ...`) and the client parameterises
(`request<RepoResponse>(...)`).

**Naming the type is a convention the compiler cannot enforce on its own**, and
this is worth stating plainly because the obvious assumption is wrong.
Narrowing `request<SessionResponse>` back to `request<{ session }>` by hand
compiles cleanly: dropping a field from a return type breaks no consumer
unless one happens to read it, which is exactly why all three drifts survived
unnoticed. A runtime test does not close the gap either — the value comes from
a `fetch` mock, so the field is present at runtime whatever the type claims.

So the convention is backed by **type-level tests**
(`apps/web/src/api/client.contract.test-d.ts`, run via
`pnpm --filter @dilna/web run test:types`). `expectTypeOf(...).toEqualTypeOf`
is invariant, so it rejects a client type that is merely *assignable* to the
envelope — which is what a hand-narrowed one is. This was verified by
reintroducing the `contextUsage` drift and confirming the suite fails.

`LlmConfig` stays in `apiSchemas.ts` rather than moving: it was already shared,
and it is assembled from `CustomProviderView`/`ProviderModelOption` which live
beside the custom-provider schemas. Moving it would trade one cross-file hop
for another with no compile-time gain.

**`ok` is typed `boolean`, not the literal `true`.** On the wire it is always
`true` — a failure leaves via `HTTPException` and renders as ADR-0039's error
envelope, so there is no `ok: false` response. The literal type was tried first
and reverted: it buys no safety (nothing reads `ok`, and an `ok: false` would be
a server bug the client could not act on) while making every existing test
double returning `{ ok: true }` a compile error unless rewritten with
`as const`. Forcing that churn across mocks is the exact cost this issue set
out to remove.

**A `requireRepo` middleware** mirrors `requireSession`, resolving a Repo id to
a `Repo` or throwing the 404 once. Like its Session counterpart it is mounted
selectively, not blanket-style:

- `repos.ts`'s four `:id` routes (`GET /:id`, `GET /:id/stats`,
  `POST /:id/pull`, `POST /:id/sync`) sit behind it.
- `DELETE /:id` deliberately does **not**. It is idempotent by design —
  `RepoManager.delete` no-ops on an unknown id, and an already-gone Repo still
  satisfies the caller's intent — so guarding it would turn a 200 into a 404,
  a behaviour change rather than a refactor.
- `skills.ts`'s `/repo/:repoId` sits behind it (hence the configurable param
  name; the two route files disagree on it). `POST /skills/:id/enabled` does
  **not**: its repo id arrives in the validated JSON body, not the path, so
  there is no param to read before the body is parsed.

## Why not the alternatives

- **Zod schemas for responses rejected**, again. Same reasoning as ADR-0039:
  it would parse every payload in the browser to catch what the compiler now
  catches for free, and these shapes are produced by the server from its own
  DB rather than arriving from outside.
- **Generating both sides from an OpenAPI spec rejected**, again per ADR-0039:
  dilna's API has exactly one consumer, in the same monorepo, already sharing
  types through the compiler. The generation step would add a build
  dependency to replace an import.
- **A generic `ApiResponse<T>` wrapper rejected.** The envelopes are not
  uniform — some wrap one key (`{ repo }`), some two (`{ session,
  contextUsage }`), some add `ok`. A single generic would have to be
  parameterised by key name as well as payload, which is longer at every call
  site than naming the concrete type.
- **Hono's RPC / `hc` client type inference rejected.** It infers response
  types from the router, which would remove the duplication too, but couples
  the web build to the server's route *values* rather than a types-only
  package, cutting against ADR-0001's import boundary. It also infers from
  whatever the handler happens to return, so the three drifts above would have
  been silently enshrined rather than surfaced.
- **Blanket-mounting `requireRepo` across `/:id/*` rejected** — see
  `DELETE /:id` above. Same reasoning `requireSession` records for
  `POST /:id/messages`.

## Consequences

The three drifts are fixed, and one of them surfaced as a compile error rather
than a code review: annotating `POST /api/sessions` with the shared envelope
immediately failed `App.routing.test.tsx`, whose `vi.mock` factory returned
`{ session }` without `contextUsage`. That is the mechanism working on the
consumer side — a mock that does not match the real response now fails to
build, the same class of bug ADR-0039 noted as out of scope (`vi.mock`
factories being structurally unchecked against the real module).

The limit of that mechanism is recorded above: it fires only where a consumer
reads the field, which is why the type-level suite exists rather than trusting
the annotation alone. Anyone adding an endpoint should add its envelope to
`apiResponses.ts` and name it on both sides; the `test-d.ts` suite covers the
previously-drifted ones, not every route, since asserting all 45 would restate
the client's type surface a third time for little marginal catch.

`subscriptions` and `lastSuccessAt` are now visible to the web client, so the
push diagnostics the route was already serving can actually be surfaced in the
UI. Nothing renders them yet — that is a follow-up, but it is now a UI change
rather than a contract change.

Adding a field to a response is now a one-file edit: add it to the envelope in
`packages/shared`, and every consumer either sees it or fails to compile. Both
route-local `ListResponse`/`OneResponse` pairs are gone, along with the name
collision where each meant something different in `repos.ts` vs `sessions.ts`.

`repos.ts` lost four copies of the fetch-and-404 preamble and `skills.ts` one.
The residual risk moves from "a handler forgets its check" to "a route is
mounted on the wrong router" — mounting outside the guard fails open, and
mounting inside it can shadow a sibling — so `repos.test.ts` and
`skills.test.ts` gained tests that pin both the 404s and the route precedence
(`/repo/:repoId` vs `DELETE /:id`), including the deliberate 200 on
`DELETE /repos/:id` for an unknown Repo.

Out of scope, from issue #231's own list: per-package internal modules for
route-local helpers, and the remaining per-route error translation beyond the
Repo lookup. `POST /api/skills` still signals reinstall-vs-fresh-install only
through its 200/201 status, which `request()` discards — recorded here because
the envelope work surfaced it, not fixed, since no caller wants it today.
