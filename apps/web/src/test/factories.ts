import type { Repo, SessionView } from "@dilna/shared";

/**
 * Shared fixture factories for web tests.
 *
 * `makeSession` was independently rewritten in nine files, `makeRepo` in
 * three — byte-identical bodies behind five different signatures (`(id)`,
 * `(status)`, `()`, `(overrides)`, `(id, status)`). Every one of them had to
 * be found and edited whenever a required field was added to the type, and
 * nothing guaranteed they agreed.
 *
 * Deliberately hand-written rather than generated from a schema: these are
 * *response* shapes, which per ADR-0039 are plain TypeScript types with no
 * Zod schema to generate from — and tests assert on specific values
 * ("Fix the flaky test", `/dilna/sess-1`), so generated filler would have to
 * be overridden field by field anyway.
 *
 * The `Partial<T>` overrides parameter is the one signature that subsumes
 * all the call shapes these replaced:
 *
 * ```ts
 * makeSession()                              // the default
 * makeSession({ id: "sess-2" })              // was makeSession("sess-2")
 * makeSession({ status: "working" })         // was makeSession("working")
 * makeSession({ id: "a", status: "idle" })   // was makeSession("a", "idle")
 * ```
 */

/**
 * A Session in its resting state: idle, no token usage, on `repo-1`.
 *
 * `title` is load-bearing in `Sidebar.test.tsx`, which asserts on the text
 * "New session" — override it rather than changing this default.
 */
export function makeSession(overrides: Partial<SessionView> = {}): SessionView {
	return {
		id: "sess-1",
		repoId: "repo-1",
		title: "New session",
		agentType: "pi",
		kind: "session",
		status: "idle",
		usage: { inputTokens: 0, outputTokens: 0 },
		createdAt: 1,
		lastActiveAt: 1,
		...overrides,
	};
}

/** The `dilna` Repo the session fixtures above hang off by default. */
export function makeRepo(overrides: Partial<Repo> = {}): Repo {
	return {
		id: "repo-1",
		slug: "dilna",
		path: "/tmp/dilna",
		defaultBranch: "main",
		remoteUrl: "git@github.com:owner/dilna.git",
		createdAt: 1,
		...overrides,
	};
}
