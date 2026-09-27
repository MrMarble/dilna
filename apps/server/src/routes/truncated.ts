import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { readTruncated, recordRetrieval } from "../sessions/truncatedStore";

/**
 * Read-only retrieval of the full original behind a trim marker (issue
 * #273): `GET /api/truncated/:hash` — the marker in a trimmed tool output
 * (and the chat UI's "view original" link) carries the content hash, and
 * this serves the exact bytes as plain text, so a plain link opens the
 * original read-only. No auth — same model as every other dilna route
 * (self-hosted, single user; the `attachmentUrl`/`transcriptUrl` links rely
 * on the same).
 */
export const truncatedRoute = new Hono();

const SHA256_HEX = /^[0-9a-f]{64}$/;

truncatedRoute.get("/:hash", (c) => {
	const hash = c.req.param("hash");
	// The store's filenames are content hashes; anything that isn't one
	// simply cannot exist — fail before touching the filesystem.
	if (!SHA256_HEX.test(hash)) {
		throw new HTTPException(404, { message: "no such original" });
	}
	const content = readTruncated(hash);
	if (content === null) {
		throw new HTTPException(404, { message: "no such original" });
	}
	// The retrieval counter (issue #274) — the UI links carry the Session
	// they were opened from, so the trade reads per Session on the Metrics
	// page. Counted only when the bytes actually exist.
	recordRetrieval(hash, c.req.query("session") ?? null);
	return c.body(content, 200, { "content-type": "text/plain; charset=utf-8" });
});
