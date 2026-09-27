/**
 * Inert stand-in for `@anthropic-ai/sandbox-runtime`, used only by the
 * cache-stability measurement harness (scripts/cache-spy-hooks.mjs): the
 * fake provider runs in-process and no sandboxed command is ever issued,
 * so `SandboxManager.initialize` becomes a no-op while
 * `getDefaultWritePaths` returns the real library's default list (its
 * result is spread at module scope in `worktreeSandbox.ts`, so it must
 * stay an iterable of paths).
 */
export class SandboxManager {
	static async initialize() {}
}

export function getDefaultWritePaths() {
	return [
		"/dev/null",
		"/tmp/claude",
		"/private/tmp/claude",
		"/home/node/.npm/_logs",
	];
}
