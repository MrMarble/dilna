import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { ZodType } from "zod";
import { toApiErrorBody, zodFieldErrors } from "../middleware/errors";

/**
 * `zValidator` with dilna's error envelope wired in as the hook, so a
 * validation failure produces the same `{ error: { message, status,
 * fieldErrors } }` shape as every other error instead of
 * `@hono/zod-validator`'s default `{ success, error }` — which the web
 * client's `request()` can't read, so a rejected body surfaced in the UI as
 * a bare "request failed (400)".
 *
 * Use this everywhere instead of importing `zValidator` directly; that's the
 * only rule. There's no `createRouter()` wrapper because Hono's
 * `defaultHook` is an option on `new Hono()` and every route file constructs
 * its own router — putting the hook on the *validator* instead means a route
 * file can't forget it by building its Hono instance directly.
 *
 * 422 rather than 400: the body parsed as JSON but failed the schema, which
 * is what 422 is for. The previous hand-rolled checks returned 400 for both
 * "unparseable" and "parsed but invalid" indiscriminately.
 *
 * `zValidator` is overloaded on whether a hook is passed, and supplying
 * explicit type arguments here picks the wrong (hook-less) overload — so the
 * generics stay inferred and the hook's `result`/`c` are annotated instead.
 * That keeps `c.req.valid(target)` fully typed at every call site.
 *
 * One behaviour change worth knowing: Hono's json validator only parses a
 * body when the request carries `Content-Type: application/json`, and treats
 * a missing header as an empty body (so every field reads as absent — a 422,
 * not a parse error). The hand-rolled `await c.req.json()` this replaced was
 * lenient about that. dilna's own web client always sets the header (see
 * `apps/web/src/api/client.ts`'s `request()`, the repo's only fetch call
 * site), so nothing real regresses — but a hand-rolled `curl` against the API
 * now needs `-H 'Content-Type: application/json'`.
 */
export function validate<
	T extends ZodType,
	Target extends keyof ValidationTargets,
>(target: Target, schema: T) {
	return zValidator(target, schema, (result, c) => {
		if (result.success) return;
		return c.json(
			toApiErrorBody(
				result.error.issues[0]?.message ?? "validation failed",
				422,
				zodFieldErrors(result.error),
			),
			422,
		);
	});
}
