import type { UsageSummary } from "@dilna/shared";
import { Hono } from "hono";
import { getUsageSummary } from "../sessions/usageStats";

type SummaryResponse = { summary: UsageSummary };

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
