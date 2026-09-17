import { statfsSync } from "node:fs";
import {
	type DiskUsage,
	type UsageSummary,
	usageQuerySchema,
} from "@dilna/shared";
import { Hono } from "hono";
import { getDataDir } from "../db";
import { getUsageSummary } from "../sessions/usageStats";
import { validate } from "./factory";

type SummaryResponse = { summary: UsageSummary };
type DiskResponse = { disk: DiskUsage };

const SECONDS_PER_DAY = 86_400;

export const usageRoute = new Hono();

usageRoute.get("/", validate("query", usageQuerySchema), (c) => {
	const { days } = c.req.valid("query");
	// `days` is now `"all" | number | undefined` — a bare `Number(days)` used
	// to run here, so `?days=abc` produced NaN and fed it to getUsageSummary.
	const since =
		days === undefined || days === "all"
			? 0
			: Math.floor(Date.now() / 1000) - days * SECONDS_PER_DAY;
	const body: SummaryResponse = { summary: getUsageSummary(since) };
	return c.json(body);
});

usageRoute.get("/disk", (c) => {
	const s = statfsSync(getDataDir());
	const body: DiskResponse = {
		disk: {
			totalBytes: s.blocks * s.bsize,
			freeBytes: s.bavail * s.bsize,
		},
	};
	return c.json(body);
});
