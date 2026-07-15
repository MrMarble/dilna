import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { sessionManager } from "../sessions/manager";
import { runSseLoop } from "./sse";

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

		// 2. Subscribe to live cross-session status changes, then pump.
		await runSseLoop(stream, c.req.raw.signal, (push) => {
			const unsubscribe = sessionManager.subscribeAll((ev) => {
				push({ event: ev.type, data: JSON.stringify(ev) });
			});
			// 2b. Kick a background account-usage pull (throttled inside the
			//     manager) so a tab opened after the server sat idle gets real
			//     windows shortly after connect instead of waiting for the next
			//     turn to finish. Placed after subscribeAll so the resulting
			//     `rate_limits` broadcast can't fall between snapshot and
			//     subscription.
			sessionManager.pokeRateLimitRefresh();
			return unsubscribe;
		});
	});
});
