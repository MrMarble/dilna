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
	role: "user" | "assistant";
	parts: MessagePart[];
	createdAt: number;
};

export type SendMessageInput = {
	text: string;
};
