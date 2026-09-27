import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServerContext } from "../container";
import * as messageStore from "./messageStore";
import { readTruncated } from "./truncatedStore";

const execFileAsync = promisify(execFile);
const git = (args: string[], opts?: { cwd?: string }) =>
	execFileAsync("git", args, { ...opts, maxBuffer: 50 * 1024 * 1024 });

/**
 * Integration test for the seed-time tool-output trim (issue #272): the
 * REAL pi adapter drives two turns against a scripted provider (a fetch
 * stub answering Anthropic-messages SSE), so the outbound request bodies —
 * what the provider would actually see — can be asserted. Only the sandbox
 * is mocked: nothing here runs a sandboxed command, and its mux listener
 * cannot bind unix sockets in this environment.
 */
vi.mock("@anthropic-ai/sandbox-runtime", () => ({
	SandboxManager: { initialize: async () => {} },
	getDefaultWritePaths: () => ["/dev/null", "/tmp/claude"],
}));

let dataDir: string;
let fixtureRepo: string;
let oldDataDir: string | undefined;
let oldEnv: Record<string, string | undefined>;

let repoManager: ReturnType<typeof createServerContext>["repos"];
let sessionManager: ReturnType<typeof createServerContext>["sessions"];

/** Every /v1/messages body the provider stub saw, in order. */
const capturedBodies: Array<Record<string, unknown>> = [];

const BIG_FILE = Array.from(
	{ length: 300 },
	(_, i) => `line ${i}: ${"content ".repeat(8)}`,
).join("\n");

// ---- canned Anthropic-messages SSE ------------------------------------------

function sse(events: Array<{ event: string; data: unknown }>): Response {
	const body = events
		.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n`)
		.join("\n");
	return new Response(`${body}\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function textReply(text: string): Response {
	return sse([
		{
			event: "message_start",
			data: {
				type: "message_start",
				message: {
					id: `msg_${capturedBodies.length}`,
					role: "assistant",
					model: "claude-opus-5",
					content: [],
					usage: {
						input_tokens: 100,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			},
		},
		{
			event: "content_block_start",
			data: {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			},
		},
		{
			event: "content_block_delta",
			data: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text },
			},
		},
		{
			event: "content_block_stop",
			data: { type: "content_block_stop", index: 0 },
		},
		{
			event: "message_delta",
			data: {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: 10 },
			},
		},
		{ event: "message_stop", data: { type: "message_stop" } },
	]);
}

function toolReply(toolName: string, toolInput: unknown): Response {
	return sse([
		{
			event: "message_start",
			data: {
				type: "message_start",
				message: {
					id: `msg_${capturedBodies.length}`,
					role: "assistant",
					model: "claude-opus-5",
					content: [],
					usage: {
						input_tokens: 100,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			},
		},
		{
			event: "content_block_start",
			data: {
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: `toolu_${capturedBodies.length}`,
					name: toolName,
					input: {},
				},
			},
		},
		{
			event: "content_block_delta",
			data: {
				type: "content_block_delta",
				index: 0,
				delta: {
					type: "input_json_delta",
					partial_json: JSON.stringify(toolInput),
				},
			},
		},
		{
			event: "content_block_stop",
			data: { type: "content_block_stop", index: 0 },
		},
		{
			event: "message_delta",
			data: {
				type: "message_delta",
				delta: { stop_reason: "tool_use" },
				usage: { output_tokens: 10 },
			},
		},
		{ event: "message_stop", data: { type: "message_stop" } },
	]);
}

/** The scripted provider: reads the fixture once, then plain text. */
function providerScript(body: Record<string, unknown>): Response {
	const messages = (body.messages ?? []) as Array<{
		role: string;
		content: unknown;
	}>;
	const lastUser = [...messages].reverse().find((m) => m.role === "user");
	const lastText =
		typeof lastUser?.content === "string"
			? lastUser.content
			: JSON.stringify(lastUser?.content ?? "");

	// Title derivation: no tools, dedicated system prompt — answer and don't
	// count it as a turn body.
	if (!body.tools && JSON.stringify(body.system).includes("session titles")) {
		return textReply("Trim Integration");
	}

	const hasToolResult = messages.some(
		(m) =>
			m.role === "user" && JSON.stringify(m.content).includes("tool_result"),
	);
	if (hasToolResult) return textReply("done reading");

	if (lastText.includes("first turn"))
		return toolReply("read", { path: "big.txt" });
	return textReply("done with turn 2");
}

beforeAll(async () => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-trim-seed-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;
	oldEnv = {
		DILNA_PROVIDER: process.env.DILNA_PROVIDER,
		DILNA_MODEL: process.env.DILNA_MODEL,
		ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
	};
	process.env.DILNA_PROVIDER = "anthropic";
	process.env.DILNA_MODEL = "claude-opus-5";
	process.env.ANTHROPIC_API_KEY = "sk-ant-test";

	fixtureRepo = mkdtempSync(path.join(tmpdir(), "dilna-fixture-"));
	await git(["init", "-b", "main", fixtureRepo]);
	await git(["config", "user.email", "test@dilna.local"], { cwd: fixtureRepo });
	await git(["config", "user.name", "dilna test"], { cwd: fixtureRepo });
	writeFileSync(path.join(fixtureRepo, "big.txt"), BIG_FILE);
	await git(["add", "."], { cwd: fixtureRepo });
	await git(["commit", "-m", "fixture"], { cwd: fixtureRepo });

	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: unknown, init?: { body?: string }) => {
			const url = typeof input === "string" ? input : String(input);
			if (url.includes("/v1/messages")) {
				const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
				capturedBodies.push(body);
				return providerScript(body);
			}
			throw new Error(`unexpected fetch: ${url}`);
		}),
	);

	({ repos: repoManager, sessions: sessionManager } = createServerContext());
});

afterAll(() => {
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	for (const [k, v] of Object.entries(oldEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	vi.unstubAllGlobals();
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(fixtureRepo, { recursive: true, force: true });
});

describe("seed-time tool-output trim over a live provider (issue #272)", () => {
	it("seeds turn 1's tool result verbatim in-turn and trimmed at the next cold start", async () => {
		const repo = await repoManager.clone(fixtureRepo);
		const session = await sessionManager.create(repo.id);

		// Turn 1: the provider reads big.txt; the tool result round's
		// outbound body carries the full file.
		sessionManager.beginTurn(session.id, "first turn: read big.txt");
		await sessionManager.runTurn(session.id, "first turn: read big.txt");
		const toolResultBody = capturedBodies.find((b) =>
			JSON.stringify(b.messages ?? []).includes("tool_result"),
		);
		expect(toolResultBody).toBeDefined();
		const toolResultText = JSON.stringify(toolResultBody?.messages ?? []);
		expect(toolResultText).toContain("line 0: content");
		expect(toolResultText).toContain("line 150: content");
		expect(toolResultText).toContain("line 299: content");

		// Cold start: turn 2's outbound body carries the trimmed marker
		// instead of the full output.
		await sessionManager.stopSession(session.id);
		sessionManager.beginTurn(session.id, "second turn");
		await sessionManager.runTurn(session.id, "second turn");
		const turn2Body = capturedBodies.at(-1);
		const turn2Text = JSON.stringify(turn2Body?.messages ?? []);
		expect(turn2Text).toContain("[dilna trimmed this tool output");
		expect(turn2Text).toContain("read of big.txt");
		// Head and tail survive the trim; the middle does not.
		expect(turn2Text).toContain("line 0: content");
		expect(turn2Text).toContain("line 299: content");
		expect(turn2Text).not.toContain("line 150: content");

		// The persisted rows are untouched — the trim is a model's-view
		// concern; the transcript (and the web renderer's input) keeps the
		// verbatim text.
		const rows = messageStore.getMessages(session.id);
		const outputs = rows.flatMap((m) =>
			m.parts.filter((p) => p.type === "tool_call"),
		);
		expect(outputs.length).toBeGreaterThan(0);
		for (const part of outputs) {
			if (part.type === "tool_call") {
				expect(part.output).toContain("line 150: content");
			}
		}

		// Reversibility (#273): the turn's sizeable read landed in the
		// content-addressed original store, and the trims endpoint — the
		// same walk the seeder runs — names it by hash, so the UI's
		// "view original" link resolves to the exact bytes.
		const trims = await sessionManager.getTrims(session.id);
		const bigTrim = trims.find((t) => t.tool === "read");
		expect(bigTrim).toBeDefined();
		expect(bigTrim?.originalChars).toBe(BIG_FILE.length);
		expect(bigTrim?.removedChars).toBeGreaterThan(0);
		expect(readTruncated(bigTrim?.hash ?? "")).toBe(BIG_FILE);

		await sessionManager.delete(session.id);
	}, 60_000);
});
