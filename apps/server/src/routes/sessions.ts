import type {
	AgentType,
	ChangedFile,
	CommitInfo,
	ContextUsageEstimate,
	Message,
	SessionView,
} from "@dilna/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { repoManager } from "../repos/manager";
import { SessionNotFoundError, sessionManager } from "../sessions/manager";
import { renderTranscript } from "../sessions/transcript";
import { runSseLoop } from "./sse";

const CREATABLE_AGENT_TYPES: readonly AgentType[] = ["pi"];

type ListResponse = { sessions: SessionView[] };
type OneResponse = {
	session: SessionView;
	/** ADR-0023's addendum — see `SessionManager.getContextUsageEstimate`'s
	 * doc comment. `null` for an orchestrator Session or one whose
	 * provider/model has fallen out of dilna's catalog. */
	contextUsage: ContextUsageEstimate | null;
};
type CreateBody = { repoId: string; agentType?: AgentType };
type SendBody = { text: string };

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

sessionsRoute.post("/", async (c) => {
	const body = await c.req.json<CreateBody>();
	if (!body?.repoId) {
		throw new HTTPException(400, { message: "repoId is required" });
	}
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
	const commits = await sessionManager.getRecentCommits(id);
	const body: { commits: CommitInfo[] } = { commits };
	return c.json(body);
});

sessionsRoute.post("/:id/messages", async (c) => {
	const id = c.req.param("id");
	const body = await c.req.json<SendBody>();
	if (!body?.text) {
		throw new HTTPException(400, { message: "text is required" });
	}
	// beginTurn claims the turn slot and persists the user's message
	// synchronously — no `await` between the 409 check and the claim (see its
	// doc comment; ADR-0016 §2). This is what makes the pre-202 409 the only
	// duplicate-send surface: a fast second POST can no longer land its own
	// 202 by racing the claim through an `await`.
	let message: Message;
	try {
		message = sessionManager.beginTurn(id, body.text);
	} catch (err) {
		if (err instanceof SessionNotFoundError) {
			throw new HTTPException(404, { message: err.message });
		}
		const msg = err instanceof Error ? err.message : "send failed";
		throw new HTTPException(409, { message: msg });
	}
	// Fire the turn asynchronously. The HTTP response is sent immediately
	// (202 Accepted) and the actual stream of events arrives on the SSE
	// endpoint. This decouples the prompt from the long-lived stream so
	// the chat can keep streaming even if this request times out. The 202
	// body echoes the same persisted row already broadcast as `user_message`
	// (ADR-0016 §6), so every client converges on one message id.
	sessionManager.runTurn(id, body.text).catch((err) => {
		console.error(`[sessions] runTurn failed for ${id}:`, err);
	});
	return c.json({ ok: true, message }, 202);
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
