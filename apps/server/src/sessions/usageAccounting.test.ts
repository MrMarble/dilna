import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentStreamEvent } from "@dilna/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, getDb } from "../db";
import {
	sessions as sessionsTable,
	usageEvents as usageEventsTable,
} from "../db/schema";
import { accumulateSessionUsage } from "./usageAccounting";

let dataDir: string;
let oldDataDir: string | undefined;

beforeAll(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-usage-accounting-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;
});

afterAll(() => {
	closeDb();
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
});

function seedSession(id: string) {
	getDb()
		.insert(sessionsTable)
		.values({
			id,
			repoId: "repo-1",
			worktreePath: `/tmp/wt-${id}`,
			worktreeDirName: id,
			branchName: `agent/${id}`,
		})
		.run();
}

/** The turn-end reconciling event the pi adapter emits (issue #267's
 * fixture: input 100 + output 20 + cacheRead 300 + cacheWrite 50). */
function turnEndEvent(providerContextTokens?: number): AgentStreamEvent {
	return {
		type: "usage_update",
		messageId: "m1",
		usage: {
			inputTokens: 100,
			outputTokens: 20,
			cacheReadTokens: 300,
			cacheWriteTokens: 50,
			reasoningTokens: 0,
			costUsd: 0.03,
		},
		cumulative: {
			inputTokens: 100,
			outputTokens: 20,
			cacheReadTokens: 300,
			cacheWriteTokens: 50,
			reasoningTokens: 0,
			costUsd: 0.03,
		},
		...(providerContextTokens === undefined ? {} : { providerContextTokens }),
	};
}

function usageRowFor(sessionId: string) {
	return getDb()
		.select()
		.from(usageEventsTable)
		.where(eq(usageEventsTable.sessionId, sessionId))
		.get();
}

describe("accumulateSessionUsage", () => {
	it("stamps the provider-reported context tokens onto the turn's usage_events row", () => {
		seedSession("s1");
		accumulateSessionUsage("s1", turnEndEvent(470), {
			provider: "anthropic",
			model: "claude-opus-5",
		});
		const row = usageRowFor("s1");
		expect(row?.providerContextTokens).toBe(470);
		// Billing fields unaffected — they keep summing per round adapter-side;
		// the context occupancy is the provider's own single report.
		expect(row?.inputTokens).toBe(100);
		expect(row?.cacheReadTokens).toBe(300);
	});

	it("leaves the column null when the event carries no provider report", () => {
		seedSession("s2");
		// An adapter that doesn't report context occupancy (or a row written
		// before the field existed) must read as null, never coerced to 0.
		accumulateSessionUsage("s2", turnEndEvent(), {
			provider: "anthropic",
			model: "claude-opus-5",
		});
		expect(usageRowFor("s2")?.providerContextTokens).toBeNull();
	});
});
