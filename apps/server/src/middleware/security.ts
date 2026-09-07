import type { MiddlewareHandler } from "hono";

// Rejects requests whose Host header isn't in the allowlist. Guards against
// DNS rebinding / CSRF-style requests from a browser tab that CORS alone
// doesn't stop (CORS blocks *reading* a cross-origin response, not a simple
// GET/POST from actually reaching and executing on the server).
export function hostAllowlistMiddleware(
	allowedHosts: string[],
): MiddlewareHandler {
	return async (c, next) => {
		const host = c.req.header("host");
		if (!host || !allowedHosts.includes(host)) {
			return c.text("Forbidden", 403);
		}
		return next();
	};
}

// Requires `Authorization: Bearer <token>` on every request except the path
// given in `skipPath` (typically /api/health, so orchestrator liveness/
// readiness probes don't need the token).
export function bearerAuthMiddleware(
	token: string,
	skipPath: string,
): MiddlewareHandler {
	return async (c, next) => {
		if (c.req.path === skipPath) return next();
		if (c.req.header("authorization") !== `Bearer ${token}`) {
			return c.json({ error: "unauthorized" }, 401);
		}
		return next();
	};
}
