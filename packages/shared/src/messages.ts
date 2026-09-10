export type MessagePart =
	| { type: "text"; text: string }
	| {
			type: "tool_call";
			callId: string;
			tool: string;
			input: unknown;
			output: unknown;
			error?: string;
	  };

export type Message = {
	id: string;
	sessionId: string;
	/** `"system"` (ADR-0026) is dilna's own synthetic role, never something an
	 * agent backend produces — used exclusively for a durable, boot-time
	 * interruption notice (`SessionManager.resetAllToIdle`). Render distinctly
	 * from `"user"`/`"assistant"` (an inline notice, not a chat bubble). */
	role: "user" | "assistant" | "system";
	parts: MessagePart[];
	createdAt: number;
	/** Groups the rows one user turn produced. ADR-0026 §3 persists an
	 * assistant response as one row per pi-agent-core *round*, so a turn that
	 * calls tools across several rounds lands as several consecutive rows —
	 * this is the id that says they're one turn, so the chat renders them as
	 * one message with one grouped tool-call section (the shape the live view
	 * already has, via `NormalizeState.currentMessageId`) instead of N
	 * separate messages after a reload.
	 *
	 * Minted once per turn by `SessionManager.runTurn` and stamped on every
	 * row that turn writes, whichever path wrote it (incremental
	 * `persistRoundEvent` or the turn-end safety net), so grouping survives a
	 * reload regardless of which path won the race.
	 *
	 * Null for every row that isn't part of an agent turn: user rows (a turn
	 * has exactly one, and the user is never grouped with the reply),
	 * `"system"` boot-time notices (ADR-0026 §2), and rows persisted before
	 * this field existed. Consumers must treat null as "own message, never
	 * grouped" — never as a value to coalesce. */
	turnId?: string | null;
};

export type SendMessageInput = {
	text: string;
};
