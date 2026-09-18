import type { Message, MessagePart } from "@dilna/shared";

/**
 * Metrics for the edit-tool A/B harness (issue #138, item 1).
 *
 * The harness runs one fixed task through two edit-tool contracts and compares
 * output tokens and edit reliability. This module is the pure half: given a
 * finished Session's persisted messages, work out how hard the model had to
 * fight the edit tool to land the change.
 *
 * Everything here reads what dilna already persists (`messages.parts_json` —
 * see `sessions/messageStore.ts`), so the harness adds no telemetry. The
 * numbers it cannot get from messages (output tokens) live in `usage_events`
 * and are joined by the runner, not here.
 *
 * Kept separate from the runner so the definitions below are testable without
 * an API key or a live agent — the counting rules are where the bugs would be,
 * and they are the part worth pinning.
 */

/** What an edit-shaped tool call's `input` looks like when we can read it.
 * Deliberately loose: this is `unknown` on the wire, and a malformed or
 * future-shaped call should be counted as an edit attempt, not crash the
 * harness. */
export type EditCallStats = {
	/** Every `edit` tool call, however it turned out. */
	attempts: number;
	/** Of those, the ones that came back with an `error`. */
	failures: number;
	/** Failure-driven re-attempts: the count above, minus each file's first
	 * edit. This is the "retry loop" the harness is trying to measure — a
	 * file edited once successfully contributes 0, a file whose first edit
	 * failed then succeeded contributes 1. */
	retries: number;
	/** Distinct paths touched, for context: 1 file edited 3 times is a very
	 * different shape from 3 files edited once. */
	filesTouched: number;
};

/** The tool name whose calls we count. Matches `TOOL_ARG_KEYS`'s key and
 * `confinement.ts`'s `PATH_TOOLS` entry — see `packages/shared/src/tools.ts`. */
const EDIT_TOOL = "edit";

/** Read the `path` off an edit call's `input`, or `undefined` when the shape
 * isn't what we expect. Mirrors how `confinement.ts` reads a flat `path`. */
function pathOf(input: unknown): string | undefined {
	if (typeof input !== "object" || input === null) return undefined;
	const path = (input as { path?: unknown }).path;
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

/** Every `tool_call` part across all rows, in row order. */
function toolCallParts(messages: Message[]): MessagePart[] {
	return messages.flatMap((message) =>
		message.parts.filter((part) => part.type === "tool_call"),
	);
}

export function summarizeEditCalls(messages: Message[]): EditCallStats {
	const editCalls = toolCallParts(messages).filter(
		(part) => part.type === "tool_call" && part.tool === EDIT_TOOL,
	);

	let failures = 0;
	const firstAttemptByPath = new Set<string>();
	let retries = 0;

	for (const part of editCalls) {
		if (part.type !== "tool_call") continue;
		if (part.error !== undefined) failures++;

		// A repeat edit to a path we've already seen is a retry — whether the
		// earlier attempt failed outright or merely didn't do what the model
		// wanted (which pi reports as success with an unchanged file). Counting
		// by path, not by error, is what catches both.
		const path = pathOf(part.input);
		const key = path ?? `#unreadable-${part.callId}`;
		if (firstAttemptByPath.has(key)) retries++;
		else firstAttemptByPath.add(key);
	}

	return {
		attempts: editCalls.length,
		failures,
		retries,
		filesTouched: firstAttemptByPath.size,
	};
}
