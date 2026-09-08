import type { MiddlewareHandler } from "hono";
import { logger } from "../logger";

/**
 * Structured replacement for `hono/logger` (issue #151): same per-request
 * shape (`<-- POST /api/x` on entry was already the sole signal an operator
 * had — `--> POST /api/x 404 1ms` on exit gave no reason why), but as JSON
 * fields alongside the rest of the app's logs rather than a separate
 * unstructured stream, so a log aggregator can actually correlate a request
 * with the `component`-tagged handler logs it triggered.
 */
const log = logger.child({ component: "http" });

export function requestLogger(): MiddlewareHandler {
	return async (c, next) => {
		const start = Date.now();
		await next();
		const durationMs = Date.now() - start;
		log.info(
			{
				method: c.req.method,
				path: c.req.path,
				status: c.res.status,
				durationMs,
			},
			`${c.req.method} ${c.req.path} ${c.res.status} ${durationMs}ms`,
		);
	};
}
