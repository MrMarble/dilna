import { Hono } from "hono";

export const sessionsRoute = new Hono();

sessionsRoute.get("/", (c) => c.json({ sessions: [] }));

sessionsRoute.post("/", async (c) => {
	const body = await c.req.json<{ repoId: string }>();
	return c.json({ ok: true, repoId: body.repoId }, 201);
});

sessionsRoute.get("/:id", (c) => {
	const id = c.req.param("id");
	return c.json({ id, title: "stub" });
});

sessionsRoute.get("/:id/messages", (c) => c.json({ messages: [] }));

sessionsRoute.post("/:id/messages", async (c) => {
	const body = await c.req.json<{ text: string }>();
	return c.json({ ok: true, text: body.text });
});

sessionsRoute.post("/:id/stop", (c) => c.json({ ok: true }));

sessionsRoute.delete("/:id", (c) =>
	c.json({ ok: true, id: c.req.param("id") }),
);
