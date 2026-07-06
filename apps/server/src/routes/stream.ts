import { Hono } from "hono";
import { stream } from "hono/streaming";

export const streamRoute = new Hono();

streamRoute.get("/sessions/:id", (c) =>
	stream(c, async (s) => {
		s.write("event: session_status\ndata: idle\n\n");
		await new Promise<void>((resolve) => {
			const t = setInterval(() => resolve(), 60_000);
			c.req.raw.signal.addEventListener("abort", () => {
				clearInterval(t);
				resolve();
			});
		});
		await s.close();
	}),
);

streamRoute.get("/sidebar", (c) =>
	stream(c, async (s) => {
		s.write("event: hello\ndata: ok\n\n");
		await new Promise<void>((resolve) => {
			const t = setInterval(() => resolve(), 60_000);
			c.req.raw.signal.addEventListener("abort", () => {
				clearInterval(t);
				resolve();
			});
		});
		await s.close();
	}),
);
