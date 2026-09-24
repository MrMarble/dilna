import { readFile } from "node:fs/promises";
import {
	type AgentType,
	type ArtefactsResponse,
	type Attachment,
	type AttachmentResponse,
	type ChangedFilesResponse,
	type CommitsResponse,
	commitsQuerySchema,
	createSessionBodySchema,
	isSandboxedKind,
	type ListQueuedResponse,
	type ListSessionsResponse,
	listSessionsQuerySchema,
	type Message,
	type OkIdResponse,
	type OkResponse,
	type QueueMessageResponse,
	type SendMessageResponse,
	type SessionMessagesResponse,
	type SessionResponse,
	scoreTurnBodySchema,
	sendMessageBodySchema,
	type TurnScoreResponse,
	type TurnScoresResponse,
} from "@dilna/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { logger } from "../logger";
import { requireSession, type SessionEnv } from "../middleware/requireSession";
import { type RepoManager, RepoNotFoundError } from "../repos/manager";
import { getArtefact, listArtefacts } from "../sessions/artefacts";
import {
	AttachmentRejectedError,
	bareMimeType,
	getAttachment,
	IMAGE_MIME_TYPES,
	resolveAttachments,
	storeAttachment,
} from "../sessions/attachments";
import {
	type SessionManager,
	SessionManagerDrainingError,
	SessionNotFoundError,
	TurnInProgressError,
} from "../sessions/manager";
import {
	JudgeFailedError,
	JudgeUnavailableError,
	listScores,
	scoreTurn,
	TurnNotFoundError,
} from "../sessions/scoring";
import { toView } from "../sessions/sessionStore";
import { renderTranscript } from "../sessions/transcript";
import { validate } from "./factory";
import { runSseLoop } from "./sse";

const log = logger.child({ component: "routes/sessions" });

const CREATABLE_AGENT_TYPES: readonly AgentType[] = ["pi"];

// Response envelopes live in `@dilna/shared` (ADR-0040) so the web client's
// `request<...>` call sites name the same declaration these handlers annotate
// with. `ListResponse`/`OneResponse` used to be declared here and restated by
// hand on the client, which is how `POST /` and `POST /orchestrator` came to
// be typed without the `contextUsage` they have always sent.

// Request schemas now live in `@dilna/shared` (apiSchemas.ts) so the web
// client types its calls against the same definitions the server validates
// with — see that module's "schema what crosses the wire inbound" note.

export function createSessionsRoute(deps: {
	sessions: SessionManager;
	repos: RepoManager;
}): Hono {
	const sessionsRoute = new Hono();

	// Endpoints whose `:id` must name an existing Session. `requireSession`
	// resolves it once and 404s otherwise, so every handler below reads it off
	// the context as a non-nullable `Session` instead of re-deriving the rule
	// (issue #204). Endpoints that must *not* inherit that 404 — the idempotent
	// deletes/stop and the two turn-claiming POSTs — are mounted on
	// `sessionsRoute` directly; `requireSession`'s doc comment says why.
	const guarded = new Hono<SessionEnv>();
	guarded.use("/:id/*", requireSession(deps.sessions));
	guarded.use("/:id", requireSession(deps.sessions));

	sessionsRoute.get(
		"/",
		validate("query", listSessionsQuerySchema),
		async (c) => {
			const { repoId } = c.req.valid("query");
			const sessions = await deps.sessions.listByRepo(repoId);
			const body: ListSessionsResponse = { sessions };
			return c.json(body);
		},
	);

	guarded.get("/:id", async (c) => {
		const session = c.get("session");
		const contextUsage = await deps.sessions.getContextUsageEstimate(
			session.id,
		);
		const body: SessionResponse = { session: toView(session), contextUsage };
		return c.json(body);
	});

	// Full durable transcript as plain text — for the "copy this link, hand it
	// to another agent" export flow. Unauthenticated, like every other route
	// here: dilna has no auth model to plug into (self-hosted, single user).
	guarded.get("/:id/transcript", async (c) => {
		const session = c.get("session");
		const repo = await deps.repos.get(session.repoId);
		if (!repo) throw new HTTPException(404, { message: "repo not found" });
		const messages = await deps.sessions.getMessages(session.id);
		const lastTurnFailed = deps.sessions.getLastTurnFailed(session.id);
		const body = renderTranscript(session, repo, messages, lastTurnFailed);
		return c.text(body, 200, {
			"Content-Type": "text/markdown; charset=utf-8",
		});
	});

	// Initial snapshot for the "Changed files" panel — mirrors GET
	// /:id/messages: fetched once on mount so the panel has content before the
	// first `changed_files` SSE event (e.g. resuming a session with prior
	// turns), then kept live via the session's SSE stream thereafter.
	guarded.get("/:id/changed-files", async (c) => {
		const files = await deps.sessions.getChangedFiles(c.get("session").id);
		const body: ChangedFilesResponse = { files };
		return c.json(body);
	});

	// Recent commits reachable from the Session's Worktree HEAD, for the context
	// panel. Fetched on mount and refetched by the client after each turn (keyed
	// off the `changed_files` SSE event) rather than streamed.
	guarded.get(
		"/:id/commits",
		validate("query", commitsQuerySchema),
		async (c) => {
			// The schema `.catch`es rather than rejecting, so a junk `?limit=`
			// still falls back to getRecentCommits' own default (5) — same
			// behaviour the hand-rolled `parseCommitsLimit` had.
			const { limit } = c.req.valid("query");
			const commits = await deps.sessions.getRecentCommits(
				c.get("session").id,
				limit,
			);
			const body: CommitsResponse = { commits };
			return c.json(body);
		},
	);

	// The queue's initial snapshot — mirrors GET /:id/messages: fetched by the
	// client's on-open resync routine (ADR-0016 §4), then kept live via
	// `queue_update` events thereafter.
	guarded.get("/:id/queue", (c) => {
		const body: ListQueuedResponse = {
			queued: deps.sessions.listQueuedMessages(c.get("session").id),
		};
		return c.json(body);
	});

	sessionsRoute.post(
		"/",
		validate("json", createSessionBodySchema),
		async (c) => {
			const body = c.req.valid("json");
			if (body.agentType && !CREATABLE_AGENT_TYPES.includes(body.agentType)) {
				throw new HTTPException(400, {
					message: `unsupported agentType: ${body.agentType}`,
				});
			}
			try {
				const session = await deps.sessions.create(body.repoId, body.agentType);
				// A brand-new Session has no turns yet — nothing to estimate.
				const res: SessionResponse = { session, contextUsage: null };
				return c.json(res, 201);
			} catch (err) {
				if (err instanceof RepoNotFoundError) {
					throw new HTTPException(404, { message: err.message });
				}
				const msg = err instanceof Error ? err.message : "create failed";
				throw new HTTPException(500, { message: msg });
			}
		},
	);

	// A dedicated endpoint rather than a `kind` field on the body above (ADR-0021):
	// an orchestrator Session's repoId is always dilna's own reserved meta-repo,
	// never caller-supplied, so there's no body to validate here at all.
	sessionsRoute.post("/orchestrator", async (c) => {
		try {
			const session = await deps.sessions.createOrchestrator();
			// Orchestrator Sessions never get compaction/context reporting.
			const res: SessionResponse = { session, contextUsage: null };
			return c.json(res, 201);
		} catch (err) {
			const msg = err instanceof Error ? err.message : "create failed";
			throw new HTTPException(500, { message: msg });
		}
	});

	sessionsRoute.delete("/:id", async (c) => {
		const id = c.req.param("id");
		await deps.sessions.delete(id);
		const body: OkIdResponse = { ok: true, id };
		return c.json(body);
	});

	sessionsRoute.get("/:id/messages", async (c) => {
		const id = c.req.param("id");
		const messages = await deps.sessions.getMessages(id);
		const body: SessionMessagesResponse = { messages };
		return c.json(body);
	});

	sessionsRoute.post(
		"/:id/messages",
		validate("json", sendMessageBodySchema),
		async (c) => {
			const id = c.req.param("id");
			const body = c.req.valid("json");
			// beginTurn claims the turn slot and persists the user's message
			// synchronously — no `await` between the 409 check and the claim (see its
			// doc comment; ADR-0016 §2). This is what makes the pre-202 409 the only
			// duplicate-send surface: a fast second POST can no longer land its own
			// 202 by racing the claim through an `await`.
			// Resolved *before* the turn is claimed: an id that doesn't belong to
			// this Session must fail the send outright (400, draft preserved) rather
			// than start a turn whose message silently lost a file the user attached.
			let attachments: Attachment[];
			try {
				attachments = resolveAttachments(id, body.attachmentIds ?? []);
			} catch (err) {
				if (err instanceof AttachmentRejectedError) {
					throw new HTTPException(400, { message: err.message });
				}
				throw err;
			}
			let message: Message;
			try {
				message = deps.sessions.beginTurn(id, body.text, attachments);
			} catch (err) {
				if (err instanceof SessionNotFoundError) {
					throw new HTTPException(404, { message: err.message });
				}
				if (err instanceof SessionManagerDrainingError) {
					// Client-retryable: a new pod is (or will shortly be) up to accept
					// this same send (ADR-0026's graceful-shutdown drain).
					throw new HTTPException(503, { message: err.message });
				}
				if (err instanceof TurnInProgressError) {
					throw new HTTPException(409, { message: err.message });
				}
				const msg = err instanceof Error ? err.message : "send failed";
				throw new HTTPException(500, { message: msg });
			}
			// Fire the turn asynchronously. The HTTP response is sent immediately
			// (202 Accepted) and the actual stream of events arrives on the SSE
			// endpoint. This decouples the prompt from the long-lived stream so
			// the chat can keep streaming even if this request times out. The 202
			// body echoes the same persisted row already broadcast as `user_message`
			// (ADR-0016 §6), so every client converges on one message id.
			const turnPromise = deps.sessions.runTurn(id, body.text, attachments);
			deps.sessions.trackRunningTurn(id, turnPromise);
			turnPromise.catch((err) => {
				log.error({ sessionId: id, err }, "runTurn failed");
			});
			const res: SendMessageResponse = { ok: true, message };
			return c.json(res, 202);
		},
	);

	/**
	 * Enqueue a message submitted while a turn is in flight (ADR-0033). Same
	 * body shape and attachment resolution as the send above, but instead of
	 * claiming the turn slot (which would 409 mid-turn), the message lands in
	 * the Session's durable server-held queue and dispatches at the next turn
	 * boundary — whether or not any browser is still connected, which is the
	 * whole point: a locked phone can't dispatch a client-held queue.
	 *
	 * Deliberately a separate endpoint rather than making the send route queue
	 * on conflict: the send's pre-202 409 is the turn protocol's one
	 * duplicate-send surface (ADR-0016 §2), and a send that sometimes runs now
	 * and sometimes queues would make that contract ambiguous. The client
	 * chooses which intent it means; a queue POST that finds the Session idle
	 * still dispatches immediately (see `enqueueMessage`), so choosing "queue"
	 * on a stale status snapshot is harmless.
	 *
	 * 202: accepted for later delivery — exactly what this is.
	 */
	sessionsRoute.post(
		"/:id/queue",
		validate("json", sendMessageBodySchema),
		(c) => {
			const id = c.req.param("id");
			const body = c.req.valid("json");
			let attachments: Attachment[];
			try {
				attachments = resolveAttachments(id, body.attachmentIds ?? []);
			} catch (err) {
				if (err instanceof AttachmentRejectedError) {
					throw new HTTPException(400, { message: err.message });
				}
				throw err;
			}
			try {
				const entry = deps.sessions.enqueueMessage(id, body.text, attachments);
				const res: QueueMessageResponse = { ok: true, entry };
				return c.json(res, 202);
			} catch (err) {
				if (err instanceof SessionNotFoundError) {
					throw new HTTPException(404, { message: err.message });
				}
				const msg = err instanceof Error ? err.message : "enqueue failed";
				throw new HTTPException(500, { message: msg });
			}
		},
	);

	// The queue's initial snapshot — mirrors GET /:id/messages: fetched by the
	// client's on-open resync routine (ADR-0016 §4), then kept live via
	// `queue_update` events thereafter.

	// Withdraw a queued entry before it dispatches. Idempotent: an entry that's
	// already gone (removed elsewhere, or drained into a turn) is still `ok` —
	// either way it is no longer queued, which is all the caller asked for.
	sessionsRoute.delete("/:id/queue/:queuedId", (c) => {
		const id = c.req.param("id");
		deps.sessions.removeQueuedMessage(id, c.req.param("queuedId"));
		const body: OkResponse = { ok: true };
		return c.json(body);
	});

	/**
	 * Upload one file to a Session (issue #53). Deliberately separate from the
	 * send below rather than a multipart send: the upload is the slow, large,
	 * retryable half, and decoupling it means a failed upload costs the user
	 * nothing (the draft is untouched, no turn was claimed) while the send stays
	 * the small JSON POST whose 409 semantics ADR-0016 §2 depends on.
	 *
	 * One file per request — the composer uploads a multi-file selection
	 * concurrently, so batching here would only trade independent per-file
	 * progress and failure for an all-or-nothing round trip.
	 */
	guarded.post("/:id/attachments", async (c) => {
		const id = c.get("session").id;

		let file: File;
		try {
			const body = await c.req.parseBody();
			const candidate = body.file;
			if (!(candidate instanceof File)) {
				throw new HTTPException(400, {
					message: "expected a multipart body with a `file` field",
				});
			}
			file = candidate;
		} catch (err) {
			if (err instanceof HTTPException) throw err;
			throw new HTTPException(400, { message: "malformed multipart body" });
		}

		try {
			const attachment = storeAttachment(id, {
				filename: file.name,
				// A browser that can't guess the type sends an empty string; keep the
				// generic binary type rather than an empty one so `attachmentKindFor`
				// and the download's Content-Type both have something valid.
				mimeType: file.type || "application/octet-stream",
				bytes: new Uint8Array(await file.arrayBuffer()),
			});
			const body: AttachmentResponse = { attachment };
			return c.json(body, 201);
		} catch (err) {
			if (err instanceof AttachmentRejectedError) {
				throw new HTTPException(413, { message: err.message });
			}
			log.error({ sessionId: id, err }, "attachment upload failed");
			throw new HTTPException(500, { message: "upload failed" });
		}
	});

	/**
	 * Serve an attachment's bytes — what the chat's `<img>` points at, and the
	 * only way the browser ever sees an upload's content (the `Attachment`
	 * records embedded in messages carry metadata only).
	 *
	 * Scoped under the Session, not a flat `/api/attachments/:id`: an attachment
	 * id is only meaningful within its owning Session (see
	 * `getAttachment`), and routing it this way makes that containment the URL's
	 * shape rather than a check a future handler could forget.
	 *
	 * `Content-Disposition: inline` because the overwhelmingly common case is an
	 * image the page renders; the filename is still supplied so an explicit
	 * download saves it under the name the user uploaded.
	 *
	 * **The headers below are load-bearing, not hygiene** (issue #222,
	 * ADR-0038). Since an Agent can mint attachment rows with
	 * `dilna_send_image`, some of these bytes are chosen by a *model* and served
	 * inline from dilna's own origin, alongside an unauthenticated `/api/*`
	 * surface — the same reasoning that locked down the artefact route below.
	 * The declared `Content-Type` is re-validated against the image allowlist
	 * rather than trusted from the row, `nosniff` stops a browser second-
	 * guessing it, and the CSP neuters anything that does get interpreted as a
	 * document. Applied to user uploads too: it costs an image nothing, and a
	 * route whose safety depends on which column a row carries is one refactor
	 * away from not having it.
	 */
	sessionsRoute.get("/:id/attachments/:attachmentId", async (c) => {
		const id = c.req.param("id");
		const attachment = getAttachment(id, c.req.param("attachmentId"));
		if (!attachment) {
			throw new HTTPException(404, { message: "attachment not found" });
		}
		let bytes: Buffer;
		try {
			bytes = await readFile(attachment.path);
		} catch {
			// Row without bytes — the file was removed underneath us. A 404 is the
			// honest answer; the message still renders its card from the embedded
			// metadata.
			throw new HTTPException(404, { message: "attachment file is missing" });
		}
		// An image is served as an image only if the stored MIME is still one of
		// the four in `IMAGE_MIME_TYPES`; anything else — including a document,
		// and including an image type later dropped from the allowlist — is
		// served as opaque binary. Never `text/html`, which is the one type that
		// would make this route an XSS vector.
		const bare = bareMimeType(attachment.mimeType);
		const safeType =
			attachment.kind === "image" && IMAGE_MIME_TYPES.has(bare)
				? bare
				: "application/octet-stream";
		c.header("Content-Type", safeType);
		c.header(
			"Content-Security-Policy",
			"sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
		);
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Referrer-Policy", "no-referrer");
		c.header(
			"Content-Disposition",
			`inline; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
		);
		// Immutable: an attachment's bytes never change once stored (a re-upload
		// mints a new id), so the browser can keep an image across re-renders and
		// reloads instead of refetching it on every message-list update.
		c.header("Cache-Control", "private, max-age=31536000, immutable");
		return c.body(bytes.buffer as ArrayBuffer);
	});

	/**
	 * A Session's published artefacts, newest first (issue #194, ADR-0032) — the
	 * context panel's initial snapshot, before any `artefact_published` event
	 * arrives on the stream.
	 */
	guarded.get("/:id/artefacts", (c) => {
		const body: ArtefactsResponse = {
			artefacts: listArtefacts(c.get("session").id),
		};
		return c.json(body);
	});

	/** Every judged turn score in the Session (issue #251, ADR-0046) — the
	 * chat's initial snapshot; new ones come back from the `POST` below. */
	guarded.get("/:id/scores", (c) => {
		const body: TurnScoresResponse = {
			scores: listScores(c.get("session").id),
		};
		return c.json(body);
	});

	/**
	 * Judge one finished turn on demand (ADR-0046). Synchronous: the several
	 * small judge calls run inside the request and the score comes back in the
	 * response — no stream event, since only the client that asked is waiting
	 * on it. 422 for an unusable judge (not in the catalog / no key), 502 when
	 * the judge ran but its replies were unusable.
	 */
	guarded.post(
		"/:id/turns/:turnId/scores",
		validate("json", scoreTurnBodySchema),
		async (c) => {
			const session = c.get("session");
			const { metric, criteria, threshold, provider, model } =
				c.req.valid("json");
			try {
				const score = await scoreTurn({
					session,
					history: await deps.sessions.getMessages(session.id),
					turnId: c.req.param("turnId"),
					metric,
					criteria,
					threshold,
					judgeOverride: provider && model ? { provider, model } : undefined,
				});
				const body: TurnScoreResponse = { score };
				return c.json(body, 201);
			} catch (err) {
				if (err instanceof TurnNotFoundError) {
					throw new HTTPException(404, { message: err.message });
				}
				if (err instanceof JudgeUnavailableError) {
					throw new HTTPException(422, { message: err.message });
				}
				if (err instanceof JudgeFailedError) {
					throw new HTTPException(502, { message: err.message });
				}
				throw err;
			}
		},
	);

	/**
	 * Serve a published artefact's bytes — what the UI's iframe points at.
	 *
	 * **The header set here is load-bearing security, not hygiene**, and it is
	 * chosen per {@link ArtefactKind} (ADR-0032, ADR-0043). Two arms:
	 *
	 * {@link isSandboxedKind} kinds are model-generated *HTML*: executable
	 * document markup served from dilna's own origin, alongside an unauthenticated
	 * `/api/*` surface. Without a restrictive CSP, a generated report could
	 * `fetch('/api/sessions/...')` and read or mutate every Session on the
	 * instance — the classic self-XSS shape, except the attacker-controlled input
	 * is the Agent's own output. `sandbox` (no token) drops the response into a
	 * unique opaque origin, so same-origin requests aren't possible even if a
	 * script did run; `default-src 'none'` plus no `script-src` means none does.
	 * `style-src 'unsafe-inline'` is the one allowance, because a self-contained
	 * report is nearly always a `<style>` block — see ADR-0032 for why
	 * interactivity is deliberately not supported here.
	 *
	 * Do not relax *that* arm without reading that ADR; a change that makes a
	 * report "work properly" is how this becomes exploitable.
	 *
	 * Every other kind is inert, and the sandbox arm would actively break one of
	 * them: `sandbox` on a PDF stops the browser handing it to its native viewer,
	 * and `default-src 'none'` blocks the blob/data URLs that viewer spins up, so
	 * a PDF served under the HTML headers renders as a blank frame. Those kinds
	 * therefore get `default-src 'none'` **without** `sandbox`, which still forbids
	 * this response from fetching anything or executing anything, while leaving
	 * the browser free to render the bytes it was already given.
	 *
	 * The safety of the inert arm rests on the *renderer*, not the header: the
	 * web app never injects markdown as HTML (react-markdown escapes it), images
	 * are bitmaps, and SVG — the one image-shaped format that would break that
	 * claim — is refused at publish time. Widening `PUBLISHABLE` with something
	 * that executes means revisiting this split, not just adding a map entry.
	 */
	sessionsRoute.get("/:id/artefacts/:artefactId", async (c) => {
		const id = c.req.param("id");
		const artefact = getArtefact(id, c.req.param("artefactId"));
		if (!artefact) {
			throw new HTTPException(404, { message: "artefact not found" });
		}
		let bytes: Buffer;
		try {
			bytes = await readFile(artefact.path);
		} catch {
			throw new HTTPException(404, { message: "artefact file is missing" });
		}
		c.header("Content-Type", artefact.mimeType);
		c.header(
			"Content-Security-Policy",
			isSandboxedKind(artefact.kind)
				? "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"
				: "default-src 'none'; base-uri 'none'; form-action 'none'",
		);
		// Belt and braces with the CSP's `default-src 'none'`: stops a browser
		// from ignoring the declared type and sniffing the bytes as something
		// else entirely.
		c.header("X-Content-Type-Options", "nosniff");
		c.header("Referrer-Policy", "no-referrer");
		// One exception to `inline`: `text/markdown` is served as an attachment so
		// that clicking through to the raw bytes *downloads* the source instead of
		// rendering as plain text in a tab. The markdown viewer renders it anyway;
		// this only affects the "open in a new tab" escape hatch, where seeing the
		// raw `.md` is what the user asked for.
		c.header(
			"Content-Disposition",
			artefact.kind === "markdown"
				? `attachment; filename*=UTF-8''${encodeURIComponent(artefact.filename)}`
				: `inline; filename*=UTF-8''${encodeURIComponent(artefact.filename)}`,
		);
		// Immutable by construction (ADR-0032): republishing mints a new id, so a
		// given artefact's bytes never change.
		c.header("Cache-Control", "private, max-age=31536000, immutable");
		return c.body(bytes.buffer as ArrayBuffer);
	});

	sessionsRoute.post("/:id/stop", async (c) => {
		const id = c.req.param("id");
		await deps.sessions.requestStop(id);
		const body: OkIdResponse = { ok: true, id };
		return c.json(body);
	});

	sessionsRoute.get("/:id/stream", (c) => {
		const id = c.req.param("id");
		return streamSSE(c, async (stream) => {
			// History travels exclusively via REST refetch (`GET /:id/messages`) —
			// per ADR-0016 §4 there is no `message_replay` on this stream (deleted:
			// no client ever listened for it) and no event ids/replay-based resync;
			// the client's on-open routine (reset live state → refetch → apply the
			// opening snapshot) is what makes a plain subscribe below sufficient.
			await runSseLoop(stream, c.req.raw.signal, (push) =>
				deps.sessions.subscribe(id, (ev) =>
					push({ event: ev.type, data: JSON.stringify(ev) }),
				),
			);
		});
	});

	// Mounted last so the guarded sub-app's routes are matched after the
	// explicitly-unguarded ones above — see `requireSession`'s doc comment for
	// why those endpoints deliberately stay outside the middleware.
	sessionsRoute.route("/", guarded);

	return sessionsRoute;
}
