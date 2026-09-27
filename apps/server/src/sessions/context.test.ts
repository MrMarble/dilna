import type { Message } from "@dilna/shared";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateContextTokens } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { dilnaMessagesToInitialState } from "../agents/pi";
import {
	buildInitialMessages,
	checkSessionContext,
	estimateSessionContext,
	pickCutPoint,
	summarizeSessionForArchive,
	toContextUsageEstimate,
} from "./context";

function dilnaMessage(
	id: string,
	role: "user" | "assistant",
	text: string,
	createdAt: number,
	turnId: string | null = null,
): Message {
	return {
		id,
		sessionId: "s1",
		role,
		parts: [{ type: "text", text }],
		turnId,
		createdAt,
	};
}

describe("buildInitialMessages", () => {
	const history = [
		dilnaMessage("m1", "user", "first", 1),
		dilnaMessage("m2", "assistant", "reply one", 2),
		dilnaMessage("m3", "user", "second", 3),
		dilnaMessage("m4", "assistant", "reply two", 4),
	];

	it("returns the plain reconstructed history when there is no compaction", () => {
		expect(buildInitialMessages(history, null)).toEqual(
			dilnaMessagesToInitialState(history),
		);
	});

	it("replaces everything up to and including throughMessageId with a leading summary message", () => {
		const out = buildInitialMessages(history, {
			summary: "user asked two things, both answered",
			throughMessageId: "m2",
		});
		expect(out[0]).toMatchObject({
			role: "user",
			content: expect.stringContaining("user asked two things, both answered"),
		});
		expect(out.slice(1)).toEqual(dilnaMessagesToInitialState(history.slice(2)));
	});

	it("falls back to the full raw history (plus the summary) when throughMessageId isn't found", () => {
		const out = buildInitialMessages(history, {
			summary: "stale summary",
			throughMessageId: "does-not-exist",
		});
		expect(out).toHaveLength(1 + dilnaMessagesToInitialState(history).length);
		expect(out.slice(1)).toEqual(dilnaMessagesToInitialState(history));
	});
});

describe("pickCutPoint", () => {
	it("keeps the entire history when it all fits inside keepRecentTokens", () => {
		const history = [
			dilnaMessage("m1", "user", "hi", 1),
			dilnaMessage("m2", "assistant", "hello", 2),
		];
		expect(pickCutPoint(history, 1_000_000)).toBe(0);
	});

	it("cuts older messages once the recent-token budget is exceeded, snapped to a message boundary", () => {
		const long = "x".repeat(2_000);
		const history = [
			dilnaMessage("m1", "user", long, 1),
			dilnaMessage("m2", "assistant", long, 2),
			dilnaMessage("m3", "user", long, 3),
			dilnaMessage("m4", "assistant", long, 4),
		];
		// Small enough that only the last couple of ~2000-char messages fit.
		const cutIndex = pickCutPoint(history, 700);
		expect(cutIndex).toBeGreaterThan(0);
		expect(cutIndex).toBeLessThan(history.length);
	});
});

// `claude-opus-5` is the catalog model these use throughout: a 1,000,000-token
// context window, so nothing here comes anywhere near the compaction
// threshold and no test in this file ever makes a real provider call.
describe("checkSessionContext", () => {
	it("reports the estimate but skips compaction when nowhere near the budget threshold", async () => {
		const history = [dilnaMessage("m1", "user", "hi", 1)];
		const result = await checkSessionContext(
			"anthropic",
			"claude-opus-5",
			history,
			null,
		);

		expect(result.compaction).toBeNull();
		// No compaction means no context rewrite for the caller to apply —
		// the live `Agent`'s transcript is left exactly as it was.
		expect(result.newContext).toBeNull();
		expect(result.estimate).toMatchObject({
			contextWindow: 1_000_000,
			reserveTokens: 16_384,
		});
		expect(result.estimate?.tokens).toBeGreaterThan(0);
	});

	it("returns a null estimate and no compaction for a provider/model no longer in dilna's catalog, without throwing", async () => {
		const result = await checkSessionContext(
			"anthropic",
			"not-a-real-model-id",
			[dilnaMessage("m1", "user", "hi", 1)],
			null,
		);
		expect(result).toEqual({
			estimate: null,
			compaction: null,
			newContext: null,
		});
	});

	it("estimates against the compacted view, not raw history, once a prior compaction exists", async () => {
		// Without folding in the prior compaction, estimating against the full
		// raw history here would report roughly the same size as before that
		// compaction ever happened — this is the bug this test guards against.
		const longText = "x".repeat(50_000);
		const history = [
			dilnaMessage("m1", "user", longText, 1),
			dilnaMessage("m2", "assistant", longText, 2),
			dilnaMessage("m3", "user", "and then?", 3),
			dilnaMessage("m4", "assistant", "then this.", 4),
		];
		const result = await checkSessionContext(
			"anthropic",
			"claude-opus-5",
			history,
			{
				summary: "the earlier exchange, summarized",
				throughMessageId: "m2",
			},
		);

		expect(result.compaction).toBeNull(); // nowhere near 1M tokens either way
		expect(result.estimate?.tokens).toEqual(
			estimateContextTokens(
				buildInitialMessages(history, {
					summary: "the earlier exchange, summarized",
					throughMessageId: "m2",
				}),
			).tokens,
		);
		// Sanity check that folding the compaction in actually mattered — far
		// below what the raw (uncompacted) history alone would estimate to.
		expect(result.estimate?.tokens).toBeLessThan(
			estimateContextTokens(dilnaMessagesToInitialState(history)).tokens,
		);
	});
});

describe("estimateSessionContext", () => {
	it("mirrors checkSessionContext's estimate for the same (provider, model, history, compaction)", () => {
		const history = [dilnaMessage("m1", "user", "hi", 1)];
		const result = estimateSessionContext(
			"anthropic",
			"claude-opus-5",
			history,
			null,
		);
		expect(result).toMatchObject({
			contextWindow: 1_000_000,
			reserveTokens: 16_384,
		});
		expect(result?.tokens).toBeGreaterThan(0);
	});

	it("returns null for a provider/model no longer in dilna's catalog", () => {
		expect(
			estimateSessionContext("anthropic", "not-a-real-model-id", [], null),
		).toBeNull();
	});
});

describe("summarizeSessionForArchive", () => {
	it("returns null for a session with no messages, without resolving a model", async () => {
		expect(
			await summarizeSessionForArchive("anthropic", "claude-opus-5", [], null),
		).toBeNull();
	});

	it("returns null for a provider/model no longer in dilna's catalog", async () => {
		const history = [dilnaMessage("m1", "user", "hi", 1)];
		expect(
			await summarizeSessionForArchive(
				"anthropic",
				"not-a-real-model-id",
				history,
				null,
			),
		).toBeNull();
	});

	it("returns the prior compaction's summary verbatim, with no LLM call, when nothing happened after its cutoff", async () => {
		const history = [
			dilnaMessage("m1", "user", "hi", 1),
			dilnaMessage("m2", "assistant", "hello", 2),
		];
		const summary = await summarizeSessionForArchive(
			"anthropic",
			"claude-opus-5",
			history,
			{ summary: "already fully summarized", throughMessageId: "m2" },
		);
		expect(summary).toBe("already fully summarized");
	});
});

// Issue #268: the estimate must carry *both* numbers pi-agent-core returns
// (the provider-derived `usageTokens` and the `chars/4` `trailingTokens`
// estimate) plus which one the headline figure is — never collapse them into
// one silently-trusted number.
describe("context estimate source", () => {
	/** An assistant round carrying a real provider report — the shape a live
	 * measured history ends in once its usage block survives conversion. */
	function assistantWithUsage(contextTokens: number): AgentMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-5",
			usage: {
				input: contextTokens - 20,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 2,
		} as unknown as AgentMessage;
	}

	it("reports a provider-derived figure when the history ends in an assistant message carrying usage", () => {
		const messages = [
			{ role: "user", content: "hi", timestamp: 1 },
			assistantWithUsage(120_000),
		] as AgentMessage[];
		const estimate = toContextUsageEstimate(
			estimateContextTokens(messages),
			1_000_000,
		);
		expect(estimate.source).toBe("provider");
		expect(estimate.usageTokens).toBe(120_000);
		// The history ends on the reported round itself — nothing to estimate.
		expect(estimate.trailingTokens).toBe(0);
		expect(estimate.tokens).toBe(120_000);
	});

	it("keeps the trailing estimate visible when the history ends in a user message after the last report", () => {
		const messages = [
			{ role: "user", content: "hi", timestamp: 1 },
			assistantWithUsage(120_000),
			{ role: "user", content: "x".repeat(400), timestamp: 3 },
		] as AgentMessage[];
		const estimate = toContextUsageEstimate(
			estimateContextTokens(messages),
			1_000_000,
		);
		// Still provider-derived — the walk-back finds the reported round —
		// but the user message after it is only ever a chars/4 guess, and the
		// shape says so instead of folding it invisibly into `tokens`.
		expect(estimate.source).toBe("provider");
		expect(estimate.usageTokens).toBe(120_000);
		expect(estimate.trailingTokens).toBeGreaterThan(0);
		expect(estimate.tokens).toBe(120_000 + estimate.trailingTokens);
	});

	it("flags the cold-start path as estimated when no assistant round carries a usable report", () => {
		// dilna's rows convert with an all-zero usage block, which the library
		// treats as "no report" — so the array a page load measures is summed
		// entirely from the chars/4 heuristic. That's exactly the figure the
		// panel must label an estimate rather than ground truth.
		const history = [
			dilnaMessage("m1", "user", "hi", 1),
			dilnaMessage("m2", "assistant", "hello", 2),
			dilnaMessage("m3", "user", "and then?", 3),
		];
		const estimate = estimateSessionContext(
			"anthropic",
			"claude-opus-5",
			history,
			null,
		);
		expect(estimate?.source).toBe("estimated");
		expect(estimate?.usageTokens).toBe(0);
		expect(estimate?.trailingTokens).toBe(estimate?.tokens);
	});
});
