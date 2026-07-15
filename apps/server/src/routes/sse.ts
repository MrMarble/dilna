import type { SSEStreamingApi } from "hono/streaming";

/** ~15s liveness ping (ADR-0016 §4), transport-level and outside the shared
 * `AgentStreamEvent`/`SessionListEvent` unions: any received event (this
 * included) resets the client's staleness clock, so a silent-but-open
 * connection (as opposed to one that actually dropped, which native
 * EventSource retry already covers) gets detected and reconnected instead of
 * looking alive forever. */
const PING_INTERVAL_MS = 15_000;

/**
 * Shared SSE pump for both `/api/stream` and `/api/sessions/:id/stream`
 * (ADR-0016 §4): drains a queue fed by `subscribe`, injects the liveness
 * ping on an interval, and keeps writing until `abort` fires. `subscribe`
 * should register its listener and return the matching unsubscribe; any
 * connect-time snapshot events belong in the caller, written directly to
 * `stream` before calling this.
 */
export async function runSseLoop(
	stream: SSEStreamingApi,
	abort: AbortSignal,
	subscribe: (
		push: (item: { event: string; data: string }) => void,
	) => () => void,
): Promise<void> {
	const queue: { event: string; data: string }[] = [];
	let resolveFlush: (() => void) | null = null;
	const push = (item: { event: string; data: string }) => {
		queue.push(item);
		if (resolveFlush) {
			resolveFlush();
			resolveFlush = null;
		}
	};

	const unsubscribe = subscribe(push);
	const pingTimer = setInterval(() => {
		push({ event: "ping", data: "{}" });
	}, PING_INTERVAL_MS);

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
		clearInterval(pingTimer);
		unsubscribe();
	}
}
