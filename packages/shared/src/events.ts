export type AgentStreamEvent =
	| { type: "session_status"; status: SessionStatus }
	| { type: "message_start"; messageId: string; role: "user" | "assistant" }
	| { type: "token"; messageId: string; chunk: string }
	| {
			type: "tool_call_start";
			messageId: string;
			callId: string;
			tool: string;
			input: unknown;
	  }
	| {
			type: "tool_call_end";
			messageId: string;
			callId: string;
			output: unknown;
			error?: string;
	  }
	| { type: "message_end"; messageId: string }
	| { type: "error"; message: string; stderrTail?: string[] }
	| { type: "agent_crashed"; exitCode: number; stderrTail: string[] };

export type SessionStatus =
	| "idle"
	| "starting"
	| "working"
	| "stopping"
	| "crashed";
