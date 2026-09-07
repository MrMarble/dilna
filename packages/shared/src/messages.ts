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
};

export type SendMessageInput = {
	text: string;
};
