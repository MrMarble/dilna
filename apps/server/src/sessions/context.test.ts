import type { Message } from "@dilna/shared";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateContextTokens } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { dilnaMessagesToInitialState } from "../agents/pi";
import { charsPerTokenFor } from "../agents/providerConfig";
import {
	buildInitialMessages,
	checkSessionContext,
	estimateAgentContextHeuristically,
	estimateLiveAgentContext,
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
		// Same scale as the estimator: the compacted view measured through the
		// provider's calibrated constant (issue #270), not the library's raw
		// chars/4.
		expect(result.estimate?.tokens).toEqual(
			toContextUsageEstimate(
				estimateContextTokens(
					buildInitialMessages(history, {
						summary: "the earlier exchange, summarized",
						throughMessageId: "m2",
					}),
				),
				1_000_000,
				charsPerTokenFor("anthropic"),
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

// Issue #269: the live-Agent path measures the agent's own transcript —
// no dilna-row rebuild — so the shape is the pi `AgentMessage[]` the agent
// holds, not dilna `Message[]` rows.
describe("estimateLiveAgentContext", () => {
	/** A completed assistant round carrying a real provider report — what a
	 * live agent's array holds after every finished round. */
	function liveAssistantRound(
		usage: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
		},
		timestamp: number,
	): AgentMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-opus-5",
			usage: {
				...usage,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp,
		} as unknown as AgentMessage;
	}

	it("derives the figure from the agent's array, grounded in its real usage report", () => {
		const messages = [
			{ role: "user", content: "hi", timestamp: 1 },
			liveAssistantRound(
				{ input: 900, output: 100, cacheRead: 5_000, cacheWrite: 0 },
				2,
			),
		] as AgentMessage[];
		const estimate = estimateLiveAgentContext(
			"anthropic",
			"claude-opus-5",
			messages,
		);
		expect(estimate?.source).toBe("provider");
		expect(estimate?.usageTokens).toBe(6_000);
		expect(estimate?.trailingTokens).toBe(0);
		expect(estimate?.tokens).toBe(6_000);
	});

	it("excludes the in-flight turn's trailing user message — the meter reflects completed turns", () => {
		// The turn in flight has been prompted but no round has completed: the
		// array ends in the (huge) new user message. It is not yet prior
		// context — same exclusion as the cold path's pending user row — so a
		// long turn must not make the meter jump when it starts.
		const messages = [
			{ role: "user", content: "hi", timestamp: 1 },
			liveAssistantRound(
				{ input: 900, output: 100, cacheRead: 0, cacheWrite: 0 },
				2,
			),
			{ role: "user", content: "x".repeat(100_000), timestamp: 3 },
		] as AgentMessage[];
		const estimate = estimateLiveAgentContext(
			"anthropic",
			"claude-opus-5",
			messages,
		);
		expect(estimate?.tokens).toBe(1_000);
		expect(estimate?.trailingTokens).toBe(0);
	});

	it("reads as an estimate right after a compaction, where the swapped-in array carries no usage", () => {
		// checkContextAndCompact swaps the live array to buildInitialMessages'
		// output — dilna-converted rows with zeroed usage — so until the next
		// round completes there is no report to ground on, and the shape says
		// so instead of implying precision.
		const compacted = dilnaMessagesToInitialState([
			dilnaMessage("m1", "user", "tail after the summary", 1),
			dilnaMessage("m2", "assistant", "tail reply", 2),
		]);
		const estimate = estimateLiveAgentContext(
			"anthropic",
			"claude-opus-5",
			compacted,
		);
		expect(estimate?.source).toBe("estimated");
		expect(estimate?.usageTokens).toBe(0);
		expect(estimate?.tokens).toBeGreaterThan(0);
	});

	it("returns null for a provider/model no longer in dilna's catalog", () => {
		expect(
			estimateLiveAgentContext("anthropic", "not-a-real-model", []),
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
			charsPerTokenFor("anthropic"),
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
			charsPerTokenFor("anthropic"),
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

// Issue #270: the estimator's one knob is the per-provider charsPerToken.
// A chars-based estimator cannot see content shape — the tests below pin
// exactly that contract: equal characters estimate equally whether they are
// JSON or prose, and the provider constant is what moves the number.
describe("estimateAgentContextHeuristically", () => {
	function userMessage(text: string): AgentMessage {
		return { role: "user", content: text, timestamp: 1 } as AgentMessage;
	}

	const JSON_PAYLOAD = JSON.stringify({
		file: "src/sessions/context.ts",
		issues: [269, 270],
		summary: "calibrate charsPerToken per provider",
		notes: "x".repeat(120),
	});
	// Padded to exactly the JSON payload's character count, so the comparison
	// isolates the constant rather than the length.
	const PROSE_PREFIX =
		"The context estimator charges every message a flat characters-per-token " +
		"rate, which the calibration below replaces with a per-provider constant. ";
	const PROSE_PAYLOAD =
		PROSE_PREFIX + "x".repeat(JSON_PAYLOAD.length - PROSE_PREFIX.length);

	it("estimates JSON-heavy and prose-heavy payloads alike — shape is invisible to a chars estimator", () => {
		expect(JSON_PAYLOAD.length).toBe(PROSE_PAYLOAD.length);
		const fromJson = estimateAgentContextHeuristically(
			"anthropic",
			"claude-opus-5",
			[userMessage(JSON_PAYLOAD)],
		);
		const fromProse = estimateAgentContextHeuristically(
			"anthropic",
			"claude-opus-5",
			[userMessage(PROSE_PAYLOAD)],
		);
		expect(fromJson).toBe(fromProse);
		expect(fromJson).toBeGreaterThan(0);
	});

	it("applies each provider's constant: same characters, different providers, proportionally different tokens", () => {
		const messages = [userMessage("y".repeat(400))];
		const raw = Math.ceil(400 / 4); // the library's chars/4 baseline
		const anthropic = estimateAgentContextHeuristically(
			"anthropic",
			"claude-opus-5",
			messages,
		);
		const deepseek = estimateAgentContextHeuristically(
			"deepseek",
			"deepseek-v4-pro",
			messages,
		);
		// round(raw × 4/constant) per ADR-0048's rescale — denser tokenizer
		// (smaller constant) means MORE estimated tokens, the safe direction.
		expect(anthropic).toBe(
			Math.round((raw * 4) / charsPerTokenFor("anthropic")),
		);
		expect(deepseek).toBe(Math.round((raw * 4) / charsPerTokenFor("deepseek")));
		expect(deepseek).toBeGreaterThan(anthropic as number);
		// A pair outside the catalog resolves no model — nothing to calibrate
		// against, so the estimate is null (the chars/4 fallback itself is
		// pinned by charsPerTokenFor's own tests in providerConfig.test.ts).
		expect(
			estimateAgentContextHeuristically("anthropic", "not-a-real-model", [
				userMessage("hi"),
			]),
		).toBeNull();
	});

	it("returns null for a provider/model no longer in dilna's catalog", () => {
		expect(
			estimateAgentContextHeuristically("anthropic", "not-a-real-model", [
				userMessage("hi"),
			]),
		).toBeNull();
	});
});
