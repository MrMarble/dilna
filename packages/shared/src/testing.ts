import type { Attachment } from "./messages";
import type { Repo } from "./repo";
import type { SessionView } from "./session";

/**
 * Fixture factories shared by every test suite in the monorepo.
 *
 * `makeSession` had been independently rewritten in nine web files and once
 * more on the server, `makeRepo` in three, behind five different signatures
 * (`(id)`, `(status)`, `()`, `(overrides)`, `(id, status)`). Every one had to
 * be found and edited whenever a required field was added to the type, and
 * nothing guaranteed they agreed — the server's copy had already drifted from
 * the web's on the `title` default. One `Partial<T>` overrides signature
 * subsumes all of them:
 *
 * ```ts
 * makeSession()                              // the default
 * makeSession({ id: "sess-2" })              // was makeSession("sess-2")
 * makeSession({ status: "working" })         // was makeSession("working")
 * makeSession({ id: "a", status: "idle" })   // was makeSession("a", "idle")
 * ```
 *
 * Deliberately hand-written rather than generated from a schema: these are
 * *response* shapes, which per ADR-0039 are plain TypeScript types with no Zod
 * schema to generate from — and tests assert on specific values ("Fix the
 * flaky test", `/dilna/sess-1`), so generated filler would have to be
 * overridden field by field anyway.
 *
 * Reached as `@dilna/shared/testing` — a subpath, not the barrel, so a
 * production import can't accidentally pull a test factory into the app
 * bundle.
 */

/**
 * A Session in its resting state: idle, no token usage, on `repo-1`.
 *
 * `title` is load-bearing in assertions that read the sidebar's text — pass an
 * override rather than relying on this default.
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

/** An image an Attachment-carrying test can hang off `sess-1`. */
export function makeAttachment(
	overrides: Partial<Attachment> = {},
): Attachment {
	return {
		id: "att-1",
		sessionId: "sess-1",
		filename: "diagram.png",
		mimeType: "image/png",
		size: 2048,
		kind: "image",
		path: "/data/attachments/sess-1/abc-diagram.png",
		createdAt: 1,
		...overrides,
	};
}
