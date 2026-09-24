import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Message } from "@dilna/shared";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const judgeComplete = vi.fn();
vi.mock("../agents/pi", () => ({
	judgeComplete: (...args: unknown[]) => judgeComplete(...args),
	resolveSummarizationModel: (provider: string, id: string) =>
		provider === "gone" ? undefined : { provider, id },
}));
vi.mock("../agents/providerConfigStore", () => ({
	effectiveProvider: () => "anthropic",
	effectiveModel: () => "claude-default",
	providerApiKeyConfigured: async (provider: string) => provider !== "keyless",
}));

const { closeDb, getDb } = await import("../db");
const { usageEvents } = await import("../db/schema");
const {
	buildSubject,
	deleteScoresForSession,
	JudgeFailedError,
	JudgeUnavailableError,
	listScores,
	measureCriteria,
	measureRelevancy,
	parseJudgeJson,
	scoreTurn,
	TurnNotFoundError,
} = await import("./scoring");

let dataDir: string;
let oldDataDir: string | undefined;

beforeAll(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-scoring-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;
});

afterAll(() => {
	closeDb();
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => judgeComplete.mockReset());

function msg(
	id: string,
	role: Message["role"],
	parts: Message["parts"],
	turnId: string | null = null,
): Message {
	return { id, sessionId: "s1", role, parts, turnId, createdAt: 0 };
}

const history: Message[] = [
	msg("u0", "user", [{ type: "text", text: "earlier prompt" }]),
	msg("a0", "assistant", [{ type: "text", text: "earlier answer" }], "t0"),
	msg("u1", "user", [{ type: "text", text: "fix the failing test" }]),
	msg(
		"a1",
		"assistant",
		[
			{ type: "text", text: "Running the tests." },
			{
				type: "tool_call",
				callId: "c1",
				tool: "bash",
				input: { command: "pnpm test" },
				output: "ok",
			},
		],
		"t1",
	),
	msg("a2", "assistant", [{ type: "text", text: "Fixed and green." }], "t1"),
];

/** A judge that replies from a queue, in call order. */
function cannedJudge(...replies: (string | null)[]) {
	const prompts: string[] = [];
	const judge = async (_system: string, prompt: string) => {
		prompts.push(prompt);
		return replies.shift() ?? null;
	};
	return { judge, prompts };
}

describe("buildSubject", () => {
	it("takes the turn's rows as output and the preceding user row as input", () => {
		const subject = buildSubject(history, "t1");
		expect(subject?.input).toBe("fix the failing test");
		expect(subject?.actualOutput).toBe(
			"Running the tests.\n\nFixed and green.",
		);
		expect(subject?.toolActivity).toBe('- bash({"command":"pnpm test"})');
	});

	it("is null for a turn that isn't in the history", () => {
		expect(buildSubject(history, "nope")).toBeNull();
	});
});

describe("parseJudgeJson", () => {
	it("finds the object inside fences and prose", () => {
		expect(parseJudgeJson('Sure!\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
	});

	it("is null for no or invalid JSON", () => {
		expect(parseJudgeJson("no json here")).toBeNull();
		expect(parseJudgeJson("{broken")).toBeNull();
		expect(parseJudgeJson(null)).toBeNull();
	});
});

describe("measureCriteria", () => {
	it("derives steps first, then averages per-step scores over 10", async () => {
		const { judge, prompts } = cannedJudge(
			'{"steps": ["ran tests", "explained fix"]}',
			'{"scores": [10, 6], "reason": "Tests ran; fix explained thinly."}',
		);
		const subject = buildSubject(history, "t1");
		if (!subject) throw new Error("no subject");
		const result = await measureCriteria(
			subject,
			"Verify before claiming.",
			judge,
		);
		expect(result).toEqual({
			score: 0.8,
			reason: "Tests ran; fix explained thinly.",
		});
		// The step-derivation call never sees the reply being judged.
		expect(prompts[0]).not.toContain("Fixed and green.");
		expect(prompts[1]).toContain("1. ran tests");
		expect(prompts[1]).toContain("<tool_calls>");
	});

	it("clamps an out-of-range judge score", async () => {
		const { judge } = cannedJudge(
			'{"steps": ["x"]}',
			'{"scores": [14], "reason": "r"}',
		);
		const subject = buildSubject(history, "t1");
		if (!subject) throw new Error("no subject");
		expect((await measureCriteria(subject, "c", judge)).score).toBe(1);
	});

	it("fails when the judge returns no usable steps", async () => {
		const { judge } = cannedJudge("I refuse");
		const subject = buildSubject(history, "t1");
		if (!subject) throw new Error("no subject");
		await expect(measureCriteria(subject, "c", judge)).rejects.toBeInstanceOf(
			JudgeFailedError,
		);
	});
});

describe("measureRelevancy", () => {
	it("scores the share of statements not judged irrelevant, idk counting as relevant", async () => {
		const { judge } = cannedJudge(
			'{"statements": ["a", "b", "c", "d"]}',
			'{"verdicts": [{"verdict":"yes"},{"verdict":"idk"},{"verdict":"yes"},{"verdict":"no","reason":"off topic"}]}',
			'{"reason": "Mostly on topic."}',
		);
		const subject = buildSubject(history, "t1");
		if (!subject) throw new Error("no subject");
		expect(await measureRelevancy(subject, judge)).toEqual({
			score: 0.75,
			reason: "Mostly on topic.",
		});
	});

	it("keeps the score with a mechanical reason when the reason call fails", async () => {
		const { judge } = cannedJudge(
			'{"statements": ["a", "b"]}',
			'{"verdicts": [{"verdict":"yes"},{"verdict":"no"}]}',
			null,
		);
		const subject = buildSubject(history, "t1");
		if (!subject) throw new Error("no subject");
		expect(await measureRelevancy(subject, judge)).toEqual({
			score: 0.5,
			reason: "1 of 2 statements judged irrelevant to the prompt.",
		});
	});

	it("scores an empty reply 1 without further calls", async () => {
		const { judge, prompts } = cannedJudge('{"statements": []}');
		const subject = buildSubject(history, "t1");
		if (!subject) throw new Error("no subject");
		expect((await measureRelevancy(subject, judge)).score).toBe(1);
		expect(prompts).toHaveLength(1);
	});
});

describe("scoreTurn", () => {
	const session = {
		id: "s1",
		repoId: "r1",
		provider: "anthropic",
		model: "claude-session",
	};
	const usage = { inputTokens: 100, outputTokens: 20, costUsd: 0.01 };

	function judgeUsageRows() {
		return getDb()
			.select()
			.from(usageEvents)
			.all()
			.filter((r) => r.purpose === "judge");
	}

	it("judges with the Session's model by default, persists the score and records judge spend", async () => {
		judgeComplete
			.mockResolvedValueOnce({ text: '{"steps": ["s"]}', usage })
			.mockResolvedValueOnce({
				text: '{"scores": [4], "reason": "weak"}',
				usage,
			});
		const score = await scoreTurn({
			session,
			history,
			turnId: "t1",
			metric: "criteria",
			criteria: "be thorough",
		});
		expect(score).toMatchObject({
			turnId: "t1",
			provider: "anthropic",
			model: "claude-session",
			score: 0.4,
			threshold: 0.5,
			passed: false,
			criteria: "be thorough",
		});
		expect(listScores("s1")).toEqual([score]);
		const rows = judgeUsageRows();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			sessionId: "s1",
			inputTokens: 200,
			outputTokens: 40,
			costUsd: 0.02,
		});
	});

	it("uses the judge override and still records spend when the metric fails", async () => {
		const before = judgeUsageRows().length;
		judgeComplete.mockResolvedValue({ text: "garbage", usage });
		await expect(
			scoreTurn({
				session,
				history,
				turnId: "t1",
				metric: "relevancy",
				judgeOverride: { provider: "openai", model: "gpt-x" },
			}),
		).rejects.toBeInstanceOf(JudgeFailedError);
		const rows = judgeUsageRows();
		expect(rows).toHaveLength(before + 1);
		expect(rows.at(-1)).toMatchObject({ provider: "openai", model: "gpt-x" });
	});

	it("rejects an unknown turn, an uncatalogued judge and a keyless provider", async () => {
		await expect(
			scoreTurn({ session, history, turnId: "zz", metric: "relevancy" }),
		).rejects.toBeInstanceOf(TurnNotFoundError);
		await expect(
			scoreTurn({
				session,
				history,
				turnId: "t1",
				metric: "relevancy",
				judgeOverride: { provider: "gone", model: "m" },
			}),
		).rejects.toBeInstanceOf(JudgeUnavailableError);
		await expect(
			scoreTurn({
				session,
				history,
				turnId: "t1",
				metric: "relevancy",
				judgeOverride: { provider: "keyless", model: "m" },
			}),
		).rejects.toBeInstanceOf(JudgeUnavailableError);
		expect(judgeComplete).not.toHaveBeenCalled();
	});

	it("is pruned with the Session", () => {
		deleteScoresForSession("s1");
		expect(listScores("s1")).toEqual([]);
	});
});
