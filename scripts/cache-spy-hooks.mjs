/**
 * Module hook for `scripts/cache-spy.mjs` (issue #271's measurement
 * harness): redirects `@anthropic-ai/sandbox-runtime` to an inert stub.
 * See cache-spy.mjs's header for why the sandbox has nothing to do in this
 * harness.
 */
const STUB = new URL("./cache-sandbox-stub.mjs", import.meta.url).href;

export function resolve(specifier, context, next) {
	if (
		specifier === "@anthropic-ai/sandbox-runtime" ||
		specifier.startsWith("@anthropic-ai/sandbox-runtime/")
	) {
		return { url: STUB, shortCircuit: true, format: "module" };
	}
	return next(specifier, context);
}
