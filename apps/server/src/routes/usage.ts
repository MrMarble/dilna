import { statfsSync } from "node:fs";
import type { DiskUsage, UsageSummary } from "@dilna/shared";
import { Hono } from "hono";
import { getDataDir } from "../db";
import { getUsageSummary } from "../sessions/usageStats";

type SummaryResponse = { summary: UsageSummary };
type DiskResponse = { disk: DiskUsage };

const SECONDS_PER_DAY = 86_400;

export const usageRoute = new Hono();

usageRoute.get("/", (c) => {
	const days = c.req.query("days");
	const since =
		!days || days === "all"
			? 0
			: Math.floor(Date.now() / 1000) - Number(days) * SECONDS_PER_DAY;
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
