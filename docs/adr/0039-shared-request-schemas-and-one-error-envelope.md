# Zod request schemas in `packages/shared`, and one error envelope for every failure

## Context

dilna's HTTP API had drifted into three separate problems that turned out to
be one problem.

**Validation was applied to 5 of ~40 endpoints.** `zValidator` guarded the
POST bodies on `/repos`, `/sessions`, `/sessions/:id/messages`,
`/sessions/:id/queue` and `/skills`. Everything else hand-rolled it.
`routes/config.ts` had four `(await c.req.json().catch(() => null)) as
SomeType | null` casts followed by `typeof x !== "string"` chains, and a
`isCustomProviderFields` guard whose `Array.isArray(b.models)` check never
looked at the elements — so `models: [null]` reached `setCustomProvider` and
was persisted. `routes/usage.ts` ran a bare `Number(days)`, so `?days=abc`
produced `NaN` and passed it into `getUsageSummary(since)` as a timestamp.
Query and path params were never validated anywhere.

**Errors went out in four incompatible shapes.** A thrown `HTTPException`
renders as `text/plain` when no `onError` is mounted, and none was; the host
allowlist returned `c.text("Forbidden", 403)`; bearer auth returned
`c.json({ error: "unauthorized" })`; and `zValidator`'s built-in default hook
returned `{ success: false, error: ... }`. The web client's `request()` looked
for a JSON `message` key and found it in none of them. **The practical effect
was that no server-authored error message ever reached the UI** — "repo not
found" and "a message needs text or at least one attachment" were both
replaced by `request failed (404)` before the user saw them. A comment in
`sessions.test.ts` asserted that an app-level `onError` in `index.ts` applied
a JSON shape; there was no such handler, and the test passed only because its
plain-text expectation happened to match production too.

**Request and response envelope types were duplicated across the boundary.**
ADR-0001 requires cross-package contracts to go through `packages/shared`, and
domain types (`Repo`, `SessionView`, `Message`) did. But request bodies were
declared privately per route file, and the `/api/config` response existed
twice — `GetConfigResponse` on the server, `LlmConfig` in the web client,
synchronised only by a comment cross-reference. They had already drifted: the
client typed a custom provider's `api` as a bare `string` where the server had
a four-literal union.

These are one problem because the fixes share a home. An error envelope wants
a schema; a schema wants somewhere both sides can see it.

## Decision

**Zod moves into `packages/shared`, and request schemas live there with the
types they validate.** The package gains its first dependency (`zod`), which
is a real change to a previously dependency-free package — accepted because a
schema and the type it produces are the same artefact, and splitting them
across packages would recreate exactly the drift this ADR removes.

The rule is: **schema what crosses the wire inbound, type what goes out.**
Request bodies and query params get Zod schemas in
`packages/shared/src/apiSchemas.ts`, because they arrive from outside and must
be validated at runtime. Domain shapes stay plain TypeScript types — the
server produces them from the DB and never parses them from untrusted input,
so a runtime schema for them would be cost without benefit. Response
*envelopes* both sides need (`LlmConfig`) live alongside the schemas as types.

**One error envelope, applied in two places.**

```ts
{ error: { message: string, status: number, fieldErrors?: Record<string, string[]> } }
```

`app.onError(errorHandler)` in `index.ts` renders every thrown
`HTTPException` — all ~45 existing throw sites keep working untouched, only
their rendering changes. `validate()` in `routes/factory.ts` wraps
`zValidator` with a hook producing the same shape for validation failures.
The two security middlewares were updated to emit it directly. The web
client's `request()` narrows with `isApiErrorBody` (the same guard, shared)
and surfaces `message` and `fieldErrors`.

**Validation failures return 422, not 400.** The body parsed as JSON but
failed the schema, which is what 422 is for. The hand-rolled checks returned
400 for both "unparseable" and "parsed but invalid" indiscriminately.

**`validate()` wraps the validator, not the router.** Hono's `defaultHook` is
an option on `new Hono()`, and every route file constructs its own router —
so a `createRouter()` factory could be silently bypassed by a file that built
its Hono instance directly. Putting the hook on the validator makes that
impossible: using the wrong import is the only way to miss it, and there is
one import to grep for.

## Why not the alternatives

- **`@hono/zod-openapi` and `createRoute` contracts (the pattern this change
  was modelled on) rejected.** Rewriting ~40 handlers as route contracts to
  serve a `/reference` page buys most of its value for consumers you cannot
  typecheck against. dilna's API has exactly one consumer, in the same
  monorepo, already sharing types through the compiler. The parts of that
  pattern that do pay here — one schema for validation and types, one error
  shape, request schemas derived from a shared source — are adopted; the
  OpenAPI generation is not. Revisit if a second consumer appears, or if
  spec-derived MSW mocks become the way web tests get their fixtures.
- **Keeping zod out of `packages/shared` and importing schemas from the
  server rejected.** ADR-0001's import boundary forbids `apps/web` importing
  from `apps/server`, so the client could not see them — which is the drift
  we are fixing.
- **Runtime-validating *responses* on the client rejected.** It would catch
  server/client mismatch at the cost of parsing every payload in the browser,
  and the compiler already catches it now that both sides name one type.
- **A shared `ApiError` class rejected in favour of a plain envelope.** The
  wire format is the contract; a class would have to be reconstructed from
  JSON on the client anyway.

## Consequences

The web UI now shows real server error messages. That is a user-visible bug
fix, not a refactor — it was the motivating symptom.

`?days=abc` is now a 422 instead of silently computing usage from a `NaN`
timestamp, and a custom provider with `models: [null]` is rejected instead of
persisted.

**One behaviour change to know about:** Hono's json validator only parses a
body when the request carries `Content-Type: application/json`, and treats a
missing header as an *empty body* — so every field reads as absent, yielding a
422 rather than a parse error. The hand-rolled `await c.req.json()` was
lenient about this. `apps/web/src/api/client.ts`'s `request()` is the repo's
only fetch call site and always sets the header, so nothing real regresses,
but a hand-rolled `curl` against the API now needs it. A compatibility shim
that rewrote the header was attempted and abandoned: `HonoRequest` caches the
parsed body, so neither mutating `c.req.raw.headers` nor replacing
`c.req.raw` in middleware has any effect, and the only remaining route
(parsing the body in the shim) would have created a second parse path for no
real caller's benefit.

`parseCommitsLimit` is gone; its bound is now `commitsQuerySchema`, which
`.catch`es rather than rejecting so a junk `?limit=` still degrades to the
route's default instead of erroring. Its tests moved with it rather than being
deleted.

`CUSTOM_PROVIDER_APIS` in `providerConfig.ts` and `CustomModelDef`/
`CustomProvider` in `customProviders.ts` are now derived from the shared
schema rather than re-declared, so the four API literals exist once.

Two test files had stale comments claiming a JSON error shape came from an
`onError` that did not exist. They now mount the real `errorHandler` and
assert the production envelope.

All 857 pre-existing tests pass; 22 new ones cover the envelope, the
validator hook, and the schemas. 24 existing assertions changed 400 → 422,
all of them in validation-rejection tests.

Out of scope: response validation, multipart bodies (`POST
/:id/attachments` still parses `c.req.parseBody()` by hand, which is
appropriate), and the ~950 lines of hand-written mock data in the web tests —
that is a separate problem, and schema-generated mocks would not solve its
actual failure mode (`vi.mock` factories are structurally unchecked against
the real module, which is why `App.routing.test.tsx` mocks two methods that
do not exist).
