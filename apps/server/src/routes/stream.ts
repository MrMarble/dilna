import { Hono } from "hono";

// The per-session SSE stream now lives on /api/sessions/:id/stream (in
// sessions.ts). This module is reserved for a future cross-session
// "sidebar" SSE broadcast (per Q17) — empty for now.
export const streamRoute = new Hono();
