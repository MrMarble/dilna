import type { ApiErrorBody } from "@dilna/shared";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import { logger } from "../logger";

/**
 * The one place a thrown error becomes an HTTP response.
 *
 * Route handlers keep throwing `HTTPException` as they always have — this
 * only changes how those throws are *rendered*. Hono's built-in rendering
 * emits the message as `text/plain`, which the web client's `request()`
 * can't read (it looks for a JSON `message` key), so every server-authored
 * error message was being replaced by a generic `request failed (404)` in
 * the UI. Mounting this makes those messages reachable without touching the
 * ~45 throw sites.
 */

/** Build the wire envelope. Exported for the router factory's `defaultHook`. */
export function toApiErrorBody(
	message: string,
	status: number,
	fieldErrors?: Record<string, string[]>,
): ApiErrorBody {
	return {
		error: { message, status, ...(fieldErrors ? { fieldErrors } : {}) },
	};
}

/**
 * Zod's `flatten().fieldErrors` types values as possibly-undefined; the
 * envelope wants dense `string[]`. Also folds form-level errors (those from
 * a `.refine()` on the object rather than on a field — e.g. "a message needs
 * text or at least one attachment") under a `_` key so they aren't silently
 * dropped, since they have no field to attach to.
 */
export function zodFieldErrors(error: ZodError): Record<string, string[]> {
	const flat = error.flatten();
	const out: Record<string, string[]> = {};
	for (const [field, messages] of Object.entries(flat.fieldErrors)) {
		if (messages?.length) out[field] = messages;
	}
	if (flat.formErrors.length) out._ = flat.formErrors;
	return out;
}

/** First validation message, for the envelope's human-readable `message`. */
function firstZodMessage(error: ZodError): string {
	return error.issues[0]?.message ?? "validation failed";
}

export function errorHandler(err: Error, c: Context): Response {
	if (err instanceof HTTPException) {
		// `HTTPException` can carry a custom Response (e.g. from a middleware
		// that built one itself) — honour it rather than overwriting.
		if (err.res) return err.res;
		return c.json(
			toApiErrorBody(err.message, err.status),
			err.status as ContentfulStatusCode,
		);
	}

	// A ZodError escaping a handler means a `.parse()` ran outside a
	// validator — treat it as a validation failure rather than a 500, so the
	// client still gets field-level detail.
	if (err instanceof ZodError) {
		return c.json(
			toApiErrorBody(firstZodMessage(err), 422, zodFieldErrors(err)),
			422,
		);
	}

	// Genuinely unexpected: log it with the stack, but don't leak the message
	// to the client — an internal error's text can carry filesystem paths or
	// credential fragments.
	logger.error(
		{ err, path: c.req.path, method: c.req.method },
		"unhandled route error",
	);
	return c.json(toApiErrorBody("internal server error", 500), 500);
}

/** 404 for unmatched `/api/*` paths, in the same envelope. */
export function notFoundHandler(c: Context): Response {
	return c.json(toApiErrorBody(`no route for ${c.req.path}`, 404), 404);
}
