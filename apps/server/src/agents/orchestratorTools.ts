import type { Repo, SessionView } from "@dilna/shared";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai/compat";
import { repoManager } from "../repos/manager";

/**
 * The narrow dependency surface an orchestrator Session's tools call back
 * into `SessionManager` through — see `SessionManager.buildOrchestratorDeps`
 * for why this is injected rather than imported directly (avoiding a
 * circular import between `sessions/manager.ts` and `agents/pi.ts`).
 */
export type OrchestratorDeps = {
	/** Ordinary (non-orchestrator) Sessions, optionally filtered to one repo. */
	listSessions: (repoId?: string) => Promise<SessionView[]>;
	/** Null for an unknown id *or* an orchestrator-kind session — those
	 * aren't "children" and aren't what these tools are for inspecting. */
	getSession: (
		id: string,
	) => Promise<(SessionView & { lastMessagePreview: string | null }) | null>;
	/** Creates an ordinary Session on `repoId` and fires `prompt` as its first
	 * turn, fire-and-forget (mirrors `POST /:id/messages`'s 202 shape) —
	 * resolves once the Session row exists, not once the turn completes. */
	createChildSession: (repoId: string, prompt: string) => Promise<SessionView>;
	usageTotalsByRepo: () => Promise<
		{ repoId: string; inputTokens: number; outputTokens: number }[]
	>;
};

/**
 * Blast-radius guardrail for `dilna_create_session` (ADR-0021 decision 3):
 * fires immediately with no confirmation step, backstopped by a hard cap
 * instead. Not user-configurable — revisit if real usage needs it higher.
 */
export const ORCHESTRATOR_MAX_SESSIONS_PER_TURN = 10;

export const ORCHESTRATOR_SYSTEM_PROMPT = `You are dilna's orchestrator: a global meta-chat with no Worktree of its own, wired with tools onto dilna's own internals instead of filesystem/bash tools. You cannot read or edit any repo's files directly.

Your job is to fan work out into ordinary dilna Sessions — each Session is an independent AI coding agent working against its own git worktree/branch on one repo. Typical requests look like "work on issues 79, 80, 81 in repo dilna, one session each" or "how much have we spent on repo X this week".

- Use \`dilna_list_repos\` to see what repos exist and resolve a repo name/slug the user mentioned to its id.
- Use \`dilna_create_session\` to spawn one Session per unit of work, each with a purpose-built prompt (e.g. "Read and implement GitHub issue #79 in this repo, then open a PR" — a spawned Session has its own bash/gh access to fetch the issue itself, you don't need to fetch it for it). Spawn immediately once you've decided what to create — do not ask for confirmation first, matching how every other tool call in dilna already runs autonomously. You are capped at ${ORCHESTRATOR_MAX_SESSIONS_PER_TURN} \`dilna_create_session\` calls per turn.
- Use \`dilna_list_sessions\`/\`dilna_get_session\`/\`dilna_usage_totals\` to answer questions about existing Sessions' status, activity, or token usage. You are not notified when a spawned Session finishes — check back with these tools if asked to follow up.
- Sessions you create show up in the normal UI like any other Session; nothing about them is hidden from the user.`;

const emptySchema = Type.Object({});

const listSessionsSchema = Type.Object({
	repoId: Type.Optional(Type.String()),
});

const getSessionSchema = Type.Object({
	sessionId: Type.String(),
});

const createSessionSchema = Type.Object({
	repoId: Type.String(),
	prompt: Type.String(),
});

function reposToToolPayload(repos: Repo[]) {
	return repos.map((r) => ({
		id: r.id,
		slug: r.slug,
		defaultBranch: r.defaultBranch,
	}));
}

function jsonResult(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
		details: {},
	};
}

export function createOrchestratorTools(
	deps: OrchestratorDeps,
	// biome-ignore lint/suspicious/noExplicitAny: AgentTool<any> is the library's own alias for a type-erased tool (pi-coding-agent's `Tool` type)
): AgentTool<any>[] {
	let sessionsCreatedThisTurn = 0;

	const listRepos: AgentTool<typeof emptySchema> = {
		name: "dilna_list_repos",
		label: "List repos",
		description:
			"List every repo dilna has cloned — id, slug, and default branch. Use the returned id as `repoId` for the other tools.",
		parameters: emptySchema,
		execute: async () =>
			jsonResult(reposToToolPayload(await repoManager.list())),
	};

	const listSessions: AgentTool<typeof listSessionsSchema> = {
		name: "dilna_list_sessions",
		label: "List sessions",
		description:
			"List ordinary (non-orchestrator) Sessions — id, title, repoId, status, token usage, timestamps. Pass `repoId` to scope to one repo, omit for every Session across every repo.",
		parameters: listSessionsSchema,
		execute: async (_toolCallId, params) =>
			jsonResult(await deps.listSessions(params.repoId)),
	};

	const getSession: AgentTool<typeof getSessionSchema> = {
		name: "dilna_get_session",
		label: "Get session",
		description:
			"Get one Session's detail — status, token usage, timestamps, and a short preview of its latest message. Returns null if the id is unknown or belongs to an orchestrator session.",
		parameters: getSessionSchema,
		execute: async (_toolCallId, params) =>
			jsonResult(await deps.getSession(params.sessionId)),
	};

	const usageTotals: AgentTool<typeof emptySchema> = {
		name: "dilna_usage_totals",
		label: "Usage totals",
		description:
			"Token usage (input/output) summed per repo, across every ordinary Session on that repo.",
		parameters: emptySchema,
		execute: async () => jsonResult(await deps.usageTotalsByRepo()),
	};

	const createSession: AgentTool<typeof createSessionSchema> = {
		name: "dilna_create_session",
		label: "Create session",
		description: `Create a new Session on \`repoId\` and send \`prompt\` as its first message — the same as a user clicking "New session" and typing a message. Fires immediately, no confirmation needed. Returns the new Session's id/title right away; the Session keeps working in the background. Capped at ${ORCHESTRATOR_MAX_SESSIONS_PER_TURN} calls per turn.`,
		parameters: createSessionSchema,
		execute: async (_toolCallId, params) => {
			if (sessionsCreatedThisTurn >= ORCHESTRATOR_MAX_SESSIONS_PER_TURN) {
				throw new Error(
					`dilna_create_session cap reached (${ORCHESTRATOR_MAX_SESSIONS_PER_TURN} per turn) — report back to the user instead of creating more.`,
				);
			}
			sessionsCreatedThisTurn++;
			const session = await deps.createChildSession(
				params.repoId,
				params.prompt,
			);
			return jsonResult({
				id: session.id,
				title: session.title,
				repoId: session.repoId,
				status: session.status,
			});
		},
	};

	return [listRepos, listSessions, getSession, usageTotals, createSession];
}
