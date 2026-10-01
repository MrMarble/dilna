import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentStreamEvent, TurnToolFacts } from "@dilna/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "../db";
import {
	sessions as sessionsTable,
	usageEvents as usageEventsTable,
} from "../db/schema";
import { logger } from "../logger";
import { accumulateSessionUsage, recordSubagentUsage } from "./usageAccounting";

/**
 * The drift log's tripwire is asserted through the module-level `log` the
 * accounting module builds at import time — `logger.child()` returns one
 * shared instance, so replacing it here reaches the calls the module makes.
 */
vi.mock("../logger", () => {
	const instance = {
		warn: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
		child: vi.fn(() => instance),
	};
	return { logger: instance };
});

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
function turnEndEvent(
	providerContextTokens?: number,
	toolFacts?: TurnToolFacts,
): AgentStreamEvent {
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
		...(toolFacts === undefined ? {} : { toolFacts }),
	};
}

function usageRowFor(sessionId: string) {
	return getDb()
		.select()
		.from(usageEventsTable)
		.where(eq(usageEventsTable.sessionId, sessionId))
		.get();
}

function driftWarnCalls() {
	// logger.child() returns the same mocked instance the module-level `log`
	// captured, so its warn is the one accumulateSessionUsage calls.
	const instance = logger.child({ component: "test" }) as unknown as {
		warn: ReturnType<typeof vi.fn>;
	};
	return instance.warn;
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

	it("stamps dilna's own estimate for the same turn alongside the report (issue #270)", () => {
		seedSession("s3");
		accumulateSessionUsage(
			"s3",
			turnEndEvent(470),
			{ provider: "anthropic", model: "claude-opus-5" },
			520,
		);
		const row = usageRowFor("s3");
		expect(row?.estimatedContextTokens).toBe(520);
		expect(row?.providerContextTokens).toBe(470);
	});

	it("leaves the estimate null when the caller has nothing to stamp", () => {
		seedSession("s4");
		// Model out of the catalog → the manager passes null; the column must
		// read as null, never coerced to 0 (0 would fabricate a huge drift).
		accumulateSessionUsage("s4", turnEndEvent(470), {
			provider: "anthropic",
			model: "claude-opus-5",
		});
		expect(usageRowFor("s4")?.estimatedContextTokens).toBeNull();
	});

	it("stamps the turn's tool/skill facts onto the row (issue #292)", () => {
		seedSession("s8");
		accumulateSessionUsage(
			"s8",
			turnEndEvent(undefined, {
				tools: { bash: 3, read_skill: 1 },
				skills: { tdd: 1 },
			}),
			{ provider: "anthropic", model: "claude-opus-5" },
		);
		const row = usageRowFor("s8");
		// Round-tripped through the same JSON the aggregator parses.
		expect(JSON.parse(row?.toolFactsJson ?? "null")).toEqual({
			tools: { bash: 3, read_skill: 1 },
			skills: { tdd: 1 },
		});
	});

	it("leaves tool facts null when the event carries none — pre-feature rows stay null, never {}", () => {
		seedSession("s9");
		// Absence is the forward-only marker; an empty object would fabricate
		// "feature-era turn, zero calls" for turns that predate the capture.
		accumulateSessionUsage("s9", turnEndEvent(), {
			provider: "anthropic",
			model: "claude-opus-5",
		});
		expect(usageRowFor("s9")?.toolFactsJson).toBeNull();
	});

	it("warns when the estimate drifts past the threshold, and stays quiet within it", () => {
		const warn = driftWarnCalls();
		warn.mockClear();

		// +20% — inside the 25% threshold: stamped, but no warning.
		seedSession("s5");
		accumulateSessionUsage(
			"s5",
			turnEndEvent(1000),
			{ provider: "anthropic", model: "claude-opus-5" },
			1200,
		);
		expect(warn).not.toHaveBeenCalled();

		// +40% — past the threshold: the per-turn tripwire fires with the
		// numbers needed to act on it, no raw-SQL digging required.
		seedSession("s6");
		accumulateSessionUsage(
			"s6",
			turnEndEvent(1000),
			{ provider: "anthropic", model: "claude-opus-5" },
			1400,
		);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "s6",
				provider: "anthropic",
				estimated: 1400,
				reported: 1000,
				driftPct: 40,
			}),
			"context estimate drifts past threshold vs provider report",
		);

		// No provider report on the event → nothing comparable → no warning,
		// even with an estimate in hand.
		seedSession("s7");
		accumulateSessionUsage(
			"s7",
			turnEndEvent(),
			{ provider: "anthropic", model: "claude-opus-5" },
			9000,
		);
		expect(warn).toHaveBeenCalledTimes(1);
	});
});

describe("recordSubagentUsage (issue #307)", () => {
	it("ledgers a subagent row keyed to the task call, outside the Session's own totals", () => {
		seedSession("sess-sub");
		recordSubagentUsage(
			{ id: "sess-sub", repoId: "repo-1" },
			{
				toolCallId: "call-task-1",
				provider: "cheap-provider",
				model: "cheap-model",
				usage: {
					inputTokens: 1200,
					outputTokens: 80,
					cacheReadTokens: 400,
					cacheWriteTokens: 0,
					reasoningTokens: 5,
					costUsd: 0.002,
				},
			},
		);

		const rows = getDb()
			.select()
			.from(usageEventsTable)
			.where(eq(usageEventsTable.sessionId, "sess-sub"))
			.all();
		expect(rows).toEqual([
			expect.objectContaining({
				purpose: "subagent",
				toolCallId: "call-task-1",
				repoId: "repo-1",
				provider: "cheap-provider",
				model: "cheap-model",
				inputTokens: 1200,
				outputTokens: 80,
				cacheReadTokens: 400,
				reasoningTokens: 5,
				costUsd: 0.002,
				// Never a turn: no context stamps, no tool facts.
				providerContextTokens: null,
				toolFactsJson: null,
			}),
		]);

		// Same treatment as judge spend: the Session's own counters describe
		// its own Agent's work only.
		const session = getDb()
			.select({
				inputTokens: sessionsTable.inputTokens,
				outputTokens: sessionsTable.outputTokens,
			})
			.from(sessionsTable)
			.where(eq(sessionsTable.id, "sess-sub"))
			.get();
		expect(session).toEqual({ inputTokens: 0, outputTokens: 0 });
	});
});
