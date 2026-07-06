import { Hono } from "hono";

export const reposRoute = new Hono();

reposRoute.get("/", (c) => c.json({ repos: [] }));

reposRoute.post("/clone", async (c) => {
	const body = await c.req.json<{ url: string; slug?: string }>();
	return c.json({ ok: true, url: body.url, slug: body.slug }, 201);
});

reposRoute.delete("/:id", (c) => {
	const id = c.req.param("id");
	return c.json({ ok: true, id });
});
