import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { sessionManager } from "../sessions/manager";

// Cross-session status SSE stream (per ADR-0006 "Q17" / ADR-0008): one
// subscription per app load, independent of any single session's own
// /api/sessions/:id/stream. Feeds the sidebar's Background Agents panel and
// the chat header's session dropdown, so the UI can track every session's
// status without subscribing to each one individually.
export const streamRoute = new Hono();

streamRoute.get("/", (c) => {
	return streamSSE(c, async (stream) => {
		// 1. Snapshot every session's current status so the UI can render
		//    immediately, before any status actually changes.
		const sessions = await sessionManager.listAll();
		for (const session of sessions) {
			await stream.writeSSE({
				event: "session_status",
				data: JSON.stringify({ type: "session_status", session }),
			});
		}

		// 1b. Snapshot last-known plan rate-limit windows (already
		//     staleness-filtered by getRateLimits), if any are available. Sent
		//     only when non-empty so a fresh tab with no data yet renders no
		//     footer at all, rather than an empty one.
		const rateLimitWindows = sessionManager.getRateLimits();
		if (rateLimitWindows.length > 0) {
			await stream.writeSSE({
				event: "rate_limits",
				data: JSON.stringify({
					type: "rate_limits",
					windows: rateLimitWindows,
				}),
			});
		}

		// 2. Subscribe to live cross-session status changes.
		const queue: { event: string; data: string }[] = [];
		let resolveFlush: (() => void) | null = null;
		const unsubscribe = sessionManager.subscribeAll((ev) => {
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
