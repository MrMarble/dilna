import type {
	AgentType,
	ChangedFile,
	CommitInfo,
	Message,
	SessionView,
} from "@dilna/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { sessionManager } from "../sessions/manager";

const CREATABLE_AGENT_TYPES: readonly AgentType[] = ["claude"];

type ListResponse = { sessions: SessionView[] };
type OneResponse = { session: SessionView };
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
	const body: OneResponse = { session };
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
		const res: OneResponse = { session };
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
	// Fire the chat asynchronously. The HTTP response is sent immediately
	// (202 Accepted) and the actual stream of events arrives on the SSE
	// endpoint. This decouples the prompt from the long-lived stream so
	// the chat can keep streaming even if this request times out.
	sessionManager.sendMessage(id, body.text).catch((err) => {
		console.error(`[sessions] sendMessage failed for ${id}:`, err);
	});
	return c.json({ ok: true }, 202);
});

sessionsRoute.post("/:id/stop", async (c) => {
	const id = c.req.param("id");
	await sessionManager.stopSession(id);
	return c.json({ ok: true, id });
});

sessionsRoute.get("/:id/stream", (c) => {
	const id = c.req.param("id");
	return streamSSE(c, async (stream) => {
		// 1. Replay cached messages so the UI can render history even if the
		//    agent process is dead.
		const messages = await sessionManager.getMessages(id);
		for (const m of messages) {
			await stream.writeSSE({
				event: "message_replay",
				data: JSON.stringify(m),
			});
		}

		// 2. Subscribe to live events.
		const queue: { event: string; data: string }[] = [];
		let resolveFlush: (() => void) | null = null;
		const unsubscribe = sessionManager.subscribe(id, (ev) => {
			queue.push({ event: ev.type, data: JSON.stringify(ev) });
			if (resolveFlush) {
				resolveFlush();
				resolveFlush = null;
			}
		});

		// 3. Pump queue to the SSE stream until the client disconnects.
		const abort = c.req.raw.signal;
		try {
			while (!abort.aborted) {
				if (queue.length === 0) {
					await new Promise<void>((resolve) => {
						resolveFlush = resolve;
						abort.addEventListener("abort", () => resolve(), { once: true });
					});
				}
				while (queue.length > 0) {
					const item = queue.shift();
					if (item) {
						await stream.writeSSE({ event: item.event, data: item.data });
					}
				}
				await stream.sleep(0);
			}
		} finally {
			unsubscribe();
		}
	});
});
