import type { Message } from "@dilna/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Compaction on the `cheap` model role (issue #311). Everything real except
 * the summarization round-trip itself, which is the only part that would
 * reach a provider — so the catalog lookups, the size check and the cut
 * point are the production ones.
 */
const summarizeMessages = vi.hoisted(() => vi.fn());
vi.mock("../agents/pi", async (importOriginal) => ({
	...(await importOriginal<typeof import("../agents/pi")>()),
	summarizeMessages,
}));

const { dilnaMessagesToInitialState, resolveSummarizationModel } = await import(
	"../agents/pi"
);
const { checkSessionContext, pickSummarizer } = await import("./context");

function message(id: string, role: "user" | "assistant", chars: number) {
	return {
		id,
		sessionId: "s1",
		role,
		parts: [{ type: "text", text: "x".repeat(chars) }],
		turnId: id,
		createdAt: 1,
	} as Message;
}

// claude-haiku-4-5 has a 200k-token window, glm-5.3 a 1M one (pi-ai's
// generated catalog) — a Session on the former with ~1.2M chars of history
// is well past its compaction threshold.
const SMALL = { provider: "anthropic", model: "claude-haiku-4-5" };
const LARGE = { provider: "zai", model: "glm-5.3" };
const overflowing = [
	message("m1", "user", 400_000),
	message("m2", "assistant", 400_000),
	message("m3", "user", 400_000),
	message("m4", "assistant", 2_000),
];

beforeEach(() => summarizeMessages.mockReset());

describe("pickSummarizer", () => {
	const small = resolveSummarizationModel(SMALL.provider, SMALL.model);
	const large = resolveSummarizationModel(LARGE.provider, LARGE.model);

	it("keeps the Session's model when no cheap role is configured", () => {
		if (!small) throw new Error("catalog model missing");
		expect(pickSummarizer(small, null, [], 16_384)).toBe(small);
	});

	it("uses the cheap model when its window fits the slice plus the reserve", () => {
		if (!small || !large) throw new Error("catalog model missing");
		const slice = dilnaMessagesToInitialState([message("a", "user", 4_000)]);
		expect(pickSummarizer(large, SMALL, slice, 16_384).id).toBe(SMALL.model);
	});

	it("falls back to the Session's model when the slice is too big for the cheap window", () => {
		if (!large) throw new Error("catalog model missing");
		// ~250k tokens of history: fine for a 1M Session, not for a 200k cheap.
		const slice = dilnaMessagesToInitialState([
			message("a", "user", 1_000_000),
		]);
		expect(pickSummarizer(large, SMALL, slice, 16_384)).toBe(large);
	});

	it("falls back when the cheap pair has left the catalog", () => {
		if (!small) throw new Error("catalog model missing");
		expect(
			pickSummarizer(small, { provider: "anthropic", model: "gone" }, [], 0),
		).toBe(small);
	});
});

describe("checkSessionContext with a cheap model role", () => {
	it("summarizes on the cheap model and forwards its spend", async () => {
		summarizeMessages.mockResolvedValue("cheap summary");
		const onUsage = vi.fn();
		const result = await checkSessionContext(
			SMALL.provider,
			SMALL.model,
			overflowing,
			null,
			{ utilityModel: LARGE, onUsage },
		);

		expect(result.compaction?.summary).toBe("cheap summary");
		expect(summarizeMessages).toHaveBeenCalledTimes(1);
		expect(summarizeMessages.mock.calls[0]?.[0]).toMatchObject({
			model: { provider: LARGE.provider, id: LARGE.model },
			onUsage,
		});
	});

	it("retries on the Session's model when the cheap call fails, instead of skipping", async () => {
		summarizeMessages
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce("own-model summary");
		const result = await checkSessionContext(
			SMALL.provider,
			SMALL.model,
			overflowing,
			null,
			{ utilityModel: LARGE },
		);

		expect(result.compaction?.summary).toBe("own-model summary");
		expect(summarizeMessages.mock.calls.map((c) => c[0].model.id)).toEqual([
			LARGE.model,
			SMALL.model,
		]);
	});

	it("skips this boundary, never throws, when both models fail", async () => {
		summarizeMessages.mockResolvedValue(null);
		const result = await checkSessionContext(
			SMALL.provider,
			SMALL.model,
			overflowing,
			null,
			{ utilityModel: LARGE },
		);
		expect(result.compaction).toBeNull();
		expect(result.newContext).toBeNull();
		expect(result.estimate).not.toBeNull();
	});

	it("without a role, summarizes on the Session's model exactly as before", async () => {
		summarizeMessages.mockResolvedValue("summary");
		await checkSessionContext(SMALL.provider, SMALL.model, overflowing, null);
		expect(summarizeMessages).toHaveBeenCalledTimes(1);
		expect(summarizeMessages.mock.calls[0]?.[0].model.id).toBe(SMALL.model);
	});
});
