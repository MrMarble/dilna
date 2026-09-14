import { randomUUID } from "node:crypto";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { streamSimple, Type } from "@earendil-works/pi-ai/compat";
import {
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
} from "@earendil-works/pi-coding-agent";
import { logger } from "../logger";
import { createConfinementHook } from "./confinement";
import { createWebFetchTool } from "./webFetchTool";

const log = logger.child({ component: "agents/taskTool" });

/**
 * `task` (issue #206, ADR-0034): delegate a scoped, **read-only**
 * investigation to a fresh in-process `pi-agent-core` `Agent` that explores
 * in its own context and returns one short answer as an ordinary tool result.
 *
 * Two things this is not:
 *
 * - **Not the orchestrator.** `dilna_create_session` (ADR-0021) spawns an
 *   independent Session with its own Worktree, fire-and-forget, which never
 *   reports back. A subagent is called by the Agent itself, mid-turn, and its
 *   answer returns *into that turn*. Different mechanism, not a better
 *   `dilna_create_session`.
 * - **Not a subprocess.** pi's own official subagent example shells out to a
 *   fresh `pi` CLI in JSON mode, but only because a CLI extension has no
 *   direct `Agent` access. `pi.ts` constructs bare `Agent`s already, so this
 *   is just "construct one more" — see docs/research/pi-extensions-background-work.md
 *   (issue #101).
 *
 * The primary win is **context isolation**, not merely concurrency: spend 50k
 * tokens locating something in a throwaway context, hand 500 tokens back to
 * the parent. ADR-0023's compaction reclaims context after the fact; this
 * avoids spending it.
 */

const taskSchema = Type.Object({
	description: Type.String({
		description:
			"A short (3-5 word) label for this task, shown to the user while it runs, e.g. 'Find auth call sites'.",
	}),
	prompt: Type.String({
		description:
			"The full instruction for the subagent. It starts with NO conversation history and cannot see anything you have read or discussed, so this must be entirely self-contained: state the question, any paths or symbols it should start from, and exactly what to report back.",
	}),
});

/**
 * Blast-radius guardrail, mirroring `ORCHESTRATOR_MAX_SESSIONS_PER_TURN`
 * (ADR-0021 decision 3 / ADR-0034): fires immediately with no confirmation
 * step, backstopped by a hard per-turn cap instead. Each subagent consumes
 * real tokens against the same provider, so an unbounded fan-out is a cost
 * incident, not just a slow turn.
 */
export const MAX_TASKS_PER_TURN = 8;

/**
 * The subagent's own system prompt. Deliberately short and framed around
 * *reporting*, since its entire output is one tool result the parent reads —
 * a subagent that narrates its process wastes the context isolation it exists
 * to provide.
 */
const SUBAGENT_SYSTEM_PROMPT = `You are a research subagent inside dilna, dispatched by a parent coding agent to answer one specific question about a git worktree.

You are READ-ONLY: you have read, grep, find, ls and web_fetch. You cannot write, edit, run shell commands, or dispatch further subagents. Do not claim to have changed anything — you cannot.

Your entire output is a single report handed back to the parent agent, which cannot see your searches, your reasoning, or any file you opened. So:

- Investigate thoroughly, then answer with the findings themselves, not a description of how you looked.
- Include the concrete specifics the parent needs: file paths, line numbers, exact symbol and function names, short relevant snippets.
- If you could not determine something, say so plainly rather than guessing — a confident wrong answer is worse than an acknowledged gap.
- Be complete but not padded. No preamble, no "I hope this helps", no restating the question.`;

/** Live state for one in-flight subagent, surfaced to the UI through
 * `turn_activity.tasks[]` (ADR-0016 §5, repopulated by ADR-0034). */
export type RunningTask = {
	taskId: string;
	description: string;
	lastTool: string;
	toolUses: number;
	startedAt: number;
	/** The spawning `task` tool_call's own callId, so a client can anchor this
	 * activity line under that row. */
	toolUseId?: string;
};

export type TaskToolDeps = {
	worktreePath: string;
	sessionId: string;
	/** Read-only paths the parent also grants (the Session's attachment dir) —
	 * kept identical so a subagent can read an upload the parent mentions. */
	extraReadablePaths: string[];
	/** The parent's resolved model, inherited so a Session that configured a
	 * specific model doesn't silently fan out onto a different one. */
	model: Model<Api>;
	getApiKey: (provider: string) => Promise<string | undefined>;
	/** Called whenever the running-task set changes, so `SessionManager` can
	 * broadcast a fresh `turn_activity`. Level-based: receives the whole
	 * current list, never a delta. */
	onTasksChanged: (tasks: RunningTask[]) => void;
};

/**
 * Build the `task` tool plus the per-turn state it needs.
 *
 * The returned `resetTurn` clears the per-turn call counter; `SessionManager`
 * calls it at every turn boundary so the cap is per-turn rather than
 * per-Session.
 */
export function createTaskTool(deps: TaskToolDeps): {
	tool: AgentTool<typeof taskSchema>;
	resetTurn: () => void;
} {
	const running = new Map<string, RunningTask>();
	let callsThisTurn = 0;

	const publish = () => deps.onTasksChanged([...running.values()]);

	const tool: AgentTool<typeof taskSchema> = {
		name: "task",
		label: "Task",
		description: `Delegate a focused, read-only investigation to a subagent that works in its own separate context and reports back.

Use this to keep heavy exploration out of your own context: the subagent can read dozens of files and run many searches, and you only pay for the summary it returns. Issue several \`task\` calls in a single message to investigate independent questions in parallel.

The subagent can read, grep, find, ls and fetch URLs. It CANNOT write, edit, or run shell commands — do that work yourself once it reports back. It also cannot ask you anything or dispatch subagents of its own.

It starts with a completely empty context: it cannot see this conversation, the user's request, or anything you have already read. Write \`prompt\` so it stands alone.

Best for: locating where something lives in an unfamiliar area, tracing how a pattern is used across many files, or answering several independent questions at once. Not worth it for reading one known file — just read it yourself. Limit: ${MAX_TASKS_PER_TURN} per turn.`,
		parameters: taskSchema,
		execute: async (toolCallId, params, signal) => {
			if (callsThisTurn >= MAX_TASKS_PER_TURN) {
				// Returned as an error tool result rather than thrown: the model can
				// act on this within the same turn (do it directly instead), which is
				// the same reasoning `dilna_publish_artefact` uses for a rejection.
				return textResult(
					`Task limit reached: at most ${MAX_TASKS_PER_TURN} \`task\` calls per turn. Do this investigation directly with your own read/grep/find tools, or wait for the next turn.`,
				);
			}
			callsThisTurn++;

			const taskId = randomUUID();
			const entry: RunningTask = {
				taskId,
				description: params.description,
				lastTool: "starting",
				toolUses: 0,
				startedAt: Date.now(),
				toolUseId: toolCallId,
			};
			running.set(taskId, entry);
			publish();

			try {
				// Read-only by *omission*: the child's array simply has no
				// write/edit/bash/publish/memory tool, and no `task` of its own
				// (so nesting is structurally impossible, not depth-limited).
				// Same construction `startOrchestrator` uses to have no
				// filesystem tools at all — ADR-0034.
				const child = new Agent({
					initialState: {
						systemPrompt: SUBAGENT_SYSTEM_PROMPT,
						model: deps.model,
						tools: [
							createReadTool(deps.worktreePath),
							createGrepTool(deps.worktreePath),
							createFindTool(deps.worktreePath),
							createLsTool(deps.worktreePath),
							createWebFetchTool(),
						],
						// Cold context: no parent history. Inheriting it would
						// defeat the point — the exploration is meant to happen
						// somewhere that is not the parent's context (ADR-0034).
						messages: [],
					},
					sessionId: `${deps.sessionId}:task:${taskId}`,
					streamFn: streamSimple,
					getApiKey: (p) => deps.getApiKey(p),
					// Backstop, not the mechanism: the child's reads are
					// worktree-bounded exactly like the parent's.
					beforeToolCall: createConfinementHook(
						deps.worktreePath,
						deps.extraReadablePaths,
					),
				});

				const unsubscribe = child.subscribe((event) => {
					if (event.type === "tool_execution_start") {
						const current = running.get(taskId);
						if (!current) return;
						current.lastTool = event.toolName ?? current.lastTool;
						current.toolUses++;
						publish();
					}
				});

				// `prompt()` takes no signal — cancellation goes through the child's
				// own `abort()`, mirroring how `chatPi` wires the Session's Stop
				// button onto the parent Agent. Without this a Stop would leave
				// subagents running until they finished on their own.
				const abortChild = () => child.abort();
				signal?.addEventListener("abort", abortChild, { once: true });

				try {
					await child.prompt(params.prompt);
				} finally {
					unsubscribe();
					signal?.removeEventListener("abort", abortChild);
				}

				if (signal?.aborted) {
					return textResult("The subagent was stopped before it finished.");
				}

				const text = finalAssistantText(child);
				if (!text) {
					return textResult(
						"The subagent returned no output. Investigate directly instead.",
					);
				}
				return textResult(text);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				log.warn({ err, taskId }, "subagent task failed");
				// Not rethrown: a failed investigation is something the parent can
				// route around (do it itself), not a reason to fail the whole turn.
				return textResult(
					`The subagent failed: ${message}. Investigate directly instead.`,
				);
			} finally {
				running.delete(taskId);
				publish();
			}
		},
	};

	return {
		tool,
		resetTurn: () => {
			callsThisTurn = 0;
		},
	};
}

/**
 * `AgentToolResult` is the shape every tool must return (a bare string is not
 * valid) — this is the text-only case every branch here uses.
 *
 * Note there is deliberately no `isError` flag: `pi-agent-core`'s loop derives
 * that solely from whether `execute()` *threw* (`executeTool` hardcodes
 * `isError: false` on the success path, and `finalizeExecutedToolCall` carries
 * only content/details/usage/terminate forward from a returned result). A
 * returned `isError` would be silently dropped, so every failure here is
 * communicated to the model in the text itself, which is the part it actually
 * reads. Throwing instead would fail the whole turn — the wrong outcome for a
 * subagent the parent can simply route around.
 */
function textResult(text: string) {
	return {
		content: [{ type: "text" as const, text }],
		details: {},
	};
}

/**
 * The child's answer: the text of its last assistant message.
 *
 * Read off the Agent's own final state rather than accumulated from the event
 * stream, mirroring how `chatPi` inspects the trailing assistant message —
 * pi encodes a failed/aborted run as data on that message rather than
 * rejecting `prompt()`, so this path sees the same thing either way.
 */
function finalAssistantText(child: Agent): string {
	const messages = child.state.messages ?? [];
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message?.role !== "assistant") continue;
		// An assistant message's content is always a block array here (never a
		// bare string) — same shape `piTurnRounds` iterates.
		const text = message.content
			.map((block) => (block.type === "text" ? block.text : ""))
			.join("")
			.trim();
		if (text) return text;
	}
	return "";
}
