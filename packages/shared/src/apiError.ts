import { z } from "zod";

/**
 * The single wire shape for every failed API response.
 *
 * Before this existed the server had four incompatible error shapes —
 * `HTTPException`'s plain-text body, `c.text("Forbidden")`, `c.json({ error })`
 * from the auth middleware, and `zValidator`'s default `{ success, error }`
 * — and the web client's `request()` only ever looked for a JSON `message`
 * key. The practical result was that *no* server error message reached the
 * UI: users saw `request failed (404)` instead of `repo not found`. One
 * envelope, applied by `app.onError` + the router factory's `defaultHook`,
 * is what makes those messages reachable.
 *
 * `fieldErrors` is only populated for validation failures (422), where it
 * carries Zod's `flatten().fieldErrors` so a form can mark the offending
 * inputs instead of showing one opaque string.
 */
export const apiErrorBodySchema = z.object({
	error: z.object({
		/** Human-readable, safe to show to the user. */
		message: z.string(),
		/** Mirrors the HTTP status, so a caller holding only the body can branch. */
		status: z.number().int(),
		/** Per-field validation messages, keyed by field name. 422 only. */
		fieldErrors: z.record(z.string(), z.array(z.string())).optional(),
	}),
});

export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

/** Narrow an unknown parsed response body to the error envelope. */
export function isApiErrorBody(body: unknown): body is ApiErrorBody {
	return apiErrorBodySchema.safeParse(body).success;
}
