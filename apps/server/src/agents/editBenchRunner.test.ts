import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Message } from "@dilna/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../db";
import { usageEvents } from "../db/schema";
import { createEditFixture } from "./editBenchFixture";
import { collectRunMetrics } from "./editBenchRunner";

let dataDir: string;
let oldDataDir: string | undefined;

// Built inside beforeAll, once DILNA_DATA_DIR points at the scratch dir —
// the db handle is resolved at construction (issue #150).
beforeAll(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;
	getDb();
});

afterAll(() => {
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
});

function editCall(callId: string, error?: string): Message {
	return {
		id: `m-${callId}`,
		sessionId: "s-1",
		role: "assistant",
		createdAt: 1_700_000_000,
		turnId: "t-1",
		parts: [
			{
				type: "tool_call",
				callId,
				tool: "edit" as never,
				input: { path: "src/config.ts", edits: [] },
				output: "",
				...(error === undefined ? {} : { error }),
			},
		],
	};
}

describe("collectRunMetrics", () => {
	it("sums output tokens from the turn's usage rows and reports success", () => {
		const db = getDb();
		const sessionId = "s-usage-1";
		fixtureSession(db, sessionId, { inputTokens: 1200, outputTokens: 340 });

		const fixture = createEditFixture();
		const messages = [editCall("c1")];

		const metrics = collectRunMetrics(
			sessionId,
			messages,
			fixture.expectedText,
			fixture,
		);

		expect(metrics.outputTokens).toBe(340);
		expect(metrics.inputTokens).toBe(1200);
		expect(metrics.success).toBe(true);
		expect(metrics.edits).toEqual({
			attempts: 1,
			failures: 0,
			retries: 0,
			filesTouched: 1,
		});
	});

	it("reports a failed run when the file doesn't match the expected text", () => {
		const db = getDb();
		const sessionId = "s-usage-2";
		fixtureSession(db, sessionId, { inputTokens: 900, outputTokens: 500 });

		const fixture = createEditFixture();
		// One failed edit then a retry that still didn't produce the right file.
		const messages = [editCall("c1", "oldText not found"), editCall("c2")];

		const metrics = collectRunMetrics(
			sessionId,
			messages,
			fixture.initialText,
			fixture,
		);

		expect(metrics.success).toBe(false);
		expect(metrics.edits.failures).toBe(1);
		expect(metrics.edits.retries).toBe(1);
		expect(metrics.outputTokens).toBe(500);
	});
});

/** Insert a usage row for a session directly — this is the table
 * `accumulateSessionUsage` writes, so the test is reading the real shape. */
function fixtureSession(
	db: ReturnType<typeof getDb>,
	sessionId: string,
	usage: { inputTokens: number; outputTokens: number },
): void {
	db.insert(usageEvents)
		.values({
			id: `u-${sessionId}`,
			sessionId,
			repoId: "r-1",
			provider: "test",
			model: "test-model",
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			createdAt: Math.floor(Date.now() / 1000),
		})
		.run();
}
