/**
 * The HTTP *address* half of the API contract.
 *
 * ADR-0039 named the request bodies and ADR-0040 the response envelopes, but
 * every route path stayed a hand-typed string on both sides: the server
 * declared `app.get("/api/sessions/:id/changed-files", …)` and the client
 * called `` request(`/api/sessions/${id}/changed-files`) ``. Renaming one side
 * was a green build and a runtime 404 — exactly the drift ADR-0040's
 * "both sides name the type" rule closes for bodies, left open for addresses.
 *
 * These builders are that single source. The server mounts its routers with
 * them and the client calls through them, so a rename is one edit. Segments
 * are `encodeURIComponent`-ed, which is what the client was doing by hand in
 * three places and omitting in the rest.
 *
 * The builders are functions rather than constants because every path with a
 * parameter needs interpolation — and because a template-literal *type* can't
 * be produced from a runtime function, the return type is `string`. What the
 * compiler checks is *usage*: a call that forgets an id fails to compile,
 * which is the mistake that actually happens.
 */

const enc = encodeURIComponent;

export const paths = {
	repos: {
		/** `GET` the list, `POST` to clone. Optional `repoId` filters. */
		list: () => "/api/repos",
		get: (repoId: string) => `/api/repos/${enc(repoId)}`,
		stats: (repoId: string) => `/api/repos/${enc(repoId)}/stats`,
		pull: (repoId: string) => `/api/repos/${enc(repoId)}/pull`,
		sync: (repoId: string) => `/api/repos/${enc(repoId)}/sync`,
	},
	sessions: {
		list: (repoId?: string) =>
			repoId ? `/api/sessions?repoId=${enc(repoId)}` : "/api/sessions",
		/** `GET` one, `DELETE` one. */
		get: (sessionId: string) => `/api/sessions/${enc(sessionId)}`,
		orchestrator: () => "/api/sessions/orchestrator",
		/** `GET` history, `POST` to send. */
		messages: (sessionId: string) => `/api/sessions/${enc(sessionId)}/messages`,
		changedFiles: (sessionId: string) =>
			`/api/sessions/${enc(sessionId)}/changed-files`,
		commits: (sessionId: string, limit?: number) =>
			limit === undefined
				? `/api/sessions/${enc(sessionId)}/commits`
				: `/api/sessions/${enc(sessionId)}/commits?limit=${limit}`,
		stop: (sessionId: string) => `/api/sessions/${enc(sessionId)}/stop`,
		transcript: (sessionId: string) =>
			`/api/sessions/${enc(sessionId)}/transcript`,
		stream: (sessionId: string) => `/api/sessions/${enc(sessionId)}/stream`,
		/** `GET` the queue, `POST` to enqueue. */
		queue: (sessionId: string) => `/api/sessions/${enc(sessionId)}/queue`,
		queuedMessage: (sessionId: string, queuedId: string) =>
			`/api/sessions/${enc(sessionId)}/queue/${enc(queuedId)}`,
		/** `POST` to upload a file. */
		attachments: (sessionId: string) =>
			`/api/sessions/${enc(sessionId)}/attachments`,
		/** `GET` an attachment's bytes. */
		attachment: (sessionId: string, attachmentId: string) =>
			`/api/sessions/${enc(sessionId)}/attachments/${enc(attachmentId)}`,
		artefacts: (sessionId: string) =>
			`/api/sessions/${enc(sessionId)}/artefacts`,
		artefact: (sessionId: string, artefactId: string) =>
			`/api/sessions/${enc(sessionId)}/artefacts/${enc(artefactId)}`,
		/** `GET` every turn score in the Session. */
		scores: (sessionId: string) => `/api/sessions/${enc(sessionId)}/scores`,
		/** `POST` to judge one turn. */
		turnScores: (sessionId: string, turnId: string) =>
			`/api/sessions/${enc(sessionId)}/turns/${enc(turnId)}/scores`,
	},
	config: {
		/** `GET`, `PUT` (set override), `DELETE` (clear). */
		get: () => "/api/config",
		credentials: () => "/api/config/credentials",
		credential: (provider: string) =>
			`/api/config/credentials/${enc(provider)}`,
		customProviders: () => "/api/config/custom-providers",
		customProvider: (id: string) => `/api/config/custom-providers/${enc(id)}`,
		anthropicOauthStart: () => "/api/config/providers/anthropic/oauth/start",
		anthropicOauthComplete: () =>
			"/api/config/providers/anthropic/oauth/complete",
		anthropicOauthCancel: () => "/api/config/providers/anthropic/oauth/cancel",
		anthropicOauth: () => "/api/config/providers/anthropic/oauth",
	},
	skills: {
		/** `GET` the list, `POST` to install. */
		list: () => "/api/skills",
		search: (q: string) => `/api/skills/search?q=${enc(q)}`,
		forRepo: (repoId: string) => `/api/skills/repo/${enc(repoId)}`,
		/** A skill id is `owner/repo/name`, so it must be a single segment. The
		 * caller encodes it — with `encodeSkillId`, not `encodeURIComponent`: an
		 * edge in front of the deployment can decode a plain `%2F` back into `/`
		 * and redirect, so the id can't contain a slash at all (see
		 * `encodeSkillId`'s doc comment in `skill.ts`). */
		item: (encodedId: string) => `/api/skills/${encodedId}`,
		enabled: (encodedId: string) => `/api/skills/${encodedId}/enabled`,
	},
	push: {
		key: () => "/api/push/key",
		subscribe: () => "/api/push/subscribe",
		unsubscribe: () => "/api/push/unsubscribe",
	},
	usage: {
		summary: (days?: number) =>
			days === undefined ? "/api/usage" : `/api/usage?days=${days}`,
		disk: () => "/api/usage/disk",
	},
	/** The cross-session event stream. */
	stream: () => "/api/stream",
} as const;
