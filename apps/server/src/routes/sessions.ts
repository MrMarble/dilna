import { readFile } from "node:fs/promises";
import type {
	AgentType,
	Attachment,
	ChangedFile,
	CommitInfo,
	ContextUsageEstimate,
	Message,
	SessionView,
} from "@dilna/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { logger } from "../logger";
import { RepoNotFoundError, repoManager } from "../repos/manager";
import {
	AttachmentRejectedError,
	getAttachment,
	resolveAttachments,
	storeAttachment,
} from "../sessions/attachments";
import {
	SessionManagerDrainingError,
	SessionNotFoundError,
	sessionManager,
	TurnInProgressError,
} from "../sessions/manager";
import { renderTranscript } from "../sessions/transcript";
import { runSseLoop } from "./sse";

const log = logger.child({ component: "routes/sessions" });

const CREATABLE_AGENT_TYPES: readonly AgentType[] = ["pi"];

// Bounds the ?limit= query param on GET /:id/commits — falls back to
// SessionManager.getRecentCommits' own default (5) for anything missing,
// non-numeric, or out of a sane range, rather than passing it through raw.
export function parseCommitsLimit(raw: string | undefined): number | undefined {
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 && n <= 50 ? n : undefined;
}

type ListResponse = { sessions: SessionView[] };
type OneResponse = {
	session: SessionView;
	/** ADR-0023's addendum — see `SessionManager.getContextUsageEstimate`'s
	 * doc comment. `null` for an orchestrator Session or one whose
	 * provider/model has fallen out of dilna's catalog. */
	contextUsage: ContextUsageEstimate | null;
};

// `agentType` is validated structurally against the full shared union here;
// CREATABLE_AGENT_TYPES below still gates which of those are actually
// creatable (e.g. "openai" is a reserved placeholder, not yet implemented).
const createBodySchema = z.object({
	repoId: z.string().min(1),
	agentType: z.enum(["pi", "openai"]).optional(),
});
const sendBodySchema = z
	.object({
		// Empty is allowed at the field level so an attachment-only message
		// ("look at this") can be sent; the refinement below still rejects a
		// send that carries neither text nor files.
		text: z.string().max(200_000),
		/** Ids from `POST /:id/attachments`, in the order the composer showed
		 * them. Resolved and ownership-checked before the turn is claimed — see
		 * the send handler. */
		attachmentIds: z.array(z.string().min(1)).max(20).optional(),
	})
	.refine((body) => body.text.trim().length > 0 || body.attachmentIds?.length, {
		message: "a message needs text or at least one attachment",
	});

export const sessionsRoute = new Hono();

sessionsRoute.get("/", async (c) => {
	const repoId = c.req.query("repoId");
	if (!repoId) {
		throw new HTTPException(400, { message: "repoId query param is required" });
	}
	const sessions = await sessionManager.listByRepo(repoId);
	const body: ListResponse = { sessions };
	return c.json(body);
});

sessionsRoute.get("/:id", async (c) => {
	const id = c.req.param("id");
	const session = await sessionManager.getView(id);
	if (!session) throw new HTTPException(404, { message: "session not found" });
	const contextUsage = await sessionManager.getContextUsageEstimate(id);
	const body: OneResponse = { session, contextUsage };
	return c.json(body);
});

sessionsRoute.post("/", zValidator("json", createBodySchema), async (c) => {
	const body = c.req.valid("json");
	if (body.agentType && !CREATABLE_AGENT_TYPES.includes(body.agentType)) {
		throw new HTTPException(400, {
			message: `unsupported agentType: ${body.agentType}`,
		});
	}
	try {
		const session = await sessionManager.create(body.repoId, body.agentType);
		// A brand-new Session has no turns yet — nothing to estimate.
		const res: OneResponse = { session, contextUsage: null };
		return c.json(res, 201);
	} catch (err) {
		if (err instanceof RepoNotFoundError) {
			throw new HTTPException(404, { message: err.message });
		}
		const msg = err instanceof Error ? err.message : "create failed";
		throw new HTTPException(500, { message: msg });
	}
});

// A dedicated endpoint rather than a `kind` field on the body above (ADR-0021):
// an orchestrator Session's repoId is always dilna's own reserved meta-repo,
// never caller-supplied, so there's no body to validate here at all.
sessionsRoute.post("/orchestrator", async (c) => {
	try {
		const session = await sessionManager.createOrchestrator();
		// Orchestrator Sessions never get compaction/context reporting.
		const res: OneResponse = { session, contextUsage: null };
		return c.json(res, 201);
	} catch (err) {
		const msg = err instanceof Error ? err.message : "create failed";
		throw new HTTPException(500, { message: msg });
	}
});

sessionsRoute.delete("/:id", async (c) => {
	const id = c.req.param("id");
	await sessionManager.delete(id);
	return c.json({ ok: true, id });
});

sessionsRoute.get("/:id/messages", async (c) => {
	const id = c.req.param("id");
	const messages = await sessionManager.getMessages(id);
	const body: { messages: Message[] } = { messages };
	return c.json(body);
});

// Full durable transcript as plain text — for the "copy this link, hand it
// to another agent" export flow. Unauthenticated, like every other route
// here: dilna has no auth model to plug into (self-hosted, single user).
sessionsRoute.get("/:id/transcript", async (c) => {
	const id = c.req.param("id");
	const session = await sessionManager.get(id);
	if (!session) throw new HTTPException(404, { message: "session not found" });
	const repo = await repoManager.get(session.repoId);
	if (!repo) throw new HTTPException(404, { message: "repo not found" });
	const messages = await sessionManager.getMessages(id);
	const lastTurnFailed = sessionManager.getLastTurnFailed(id);
	const body = renderTranscript(session, repo, messages, lastTurnFailed);
	return c.text(body, 200, { "Content-Type": "text/markdown; charset=utf-8" });
});

// Initial snapshot for the "Changed files" panel — mirrors GET
// /:id/messages: fetched once on mount so the panel has content before the
// first `changed_files` SSE event (e.g. resuming a session with prior
// turns), then kept live via the session's SSE stream thereafter.
sessionsRoute.get("/:id/changed-files", async (c) => {
	const id = c.req.param("id");
	const session = await sessionManager.get(id);
	if (!session) throw new HTTPException(404, { message: "session not found" });
	const files = await sessionManager.getChangedFiles(id);
	const body: { files: ChangedFile[] } = { files };
	return c.json(body);
});

// Recent commits reachable from the Session's Worktree HEAD, for the context
// panel. Fetched on mount and refetched by the client after each turn (keyed
// off the `changed_files` SSE event) rather than streamed.
sessionsRoute.get("/:id/commits", async (c) => {
	const id = c.req.param("id");
	const session = await sessionManager.get(id);
	if (!session) throw new HTTPException(404, { message: "session not found" });
	const limit = parseCommitsLimit(c.req.query("limit"));
	const commits = await sessionManager.getRecentCommits(id, limit);
	const body: { commits: CommitInfo[] } = { commits };
	return c.json(body);
});

sessionsRoute.post(
	"/:id/messages",
	zValidator("json", sendBodySchema),
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
			message = sessionManager.beginTurn(id, body.text, attachments);
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
		const turnPromise = sessionManager.runTurn(id, body.text, attachments);
		sessionManager.trackRunningTurn(id, turnPromise);
		turnPromise.catch((err) => {
			log.error({ sessionId: id, err }, "runTurn failed");
		});
		return c.json({ ok: true, message }, 202);
	},
);

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
sessionsRoute.post("/:id/attachments", async (c) => {
	const id = c.req.param("id");
	const session = await sessionManager.get(id);
	if (!session) throw new HTTPException(404, { message: "session not found" });

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
		const body: { attachment: Attachment } = { attachment };
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
	c.header("Content-Type", attachment.mimeType);
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

sessionsRoute.post("/:id/stop", async (c) => {
	const id = c.req.param("id");
	await sessionManager.requestStop(id);
	return c.json({ ok: true, id });
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
			sessionManager.subscribe(id, (ev) =>
				push({ event: ev.type, data: JSON.stringify(ev) }),
			),
		);
	});
});
