import type {
	AgentStreamEvent,
	AgentType,
	ChangedFile,
	Message,
	Repo,
	SessionListEvent,
	SessionView,
} from "@dilna/shared";

export type {
	AgentStreamEvent,
	AgentType,
	ChangedFile,
	Message,
	Repo,
	SessionListEvent,
	SessionView,
};

export type CloneRepoInput = {
	url: string;
	slug?: string;
};

class ApiError extends Error {
	constructor(
		public status: number,
		public body: unknown,
		message: string,
	) {
		super(message);
	}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, {
		...init,
		headers: {
			"Content-Type": "application/json",
			...init?.headers,
		},
	});
	const text = await res.text();
	let body: unknown = null;
	if (text) {
		try {
			body = JSON.parse(text);
		} catch {
			body = text;
		}
	}
	if (!res.ok) {
		const msg =
			typeof body === "object" && body !== null && "message" in body
				? String((body as { message: unknown }).message)
				: `request failed (${res.status})`;
		throw new ApiError(res.status, body, msg);
	}
	return body as T;
}

export const api = {
	repos: {
		list: () => request<{ repos: Repo[] }>("/api/repos"),
		get: (id: string) => request<{ repo: Repo }>(`/api/repos/${id}`),
		clone: (input: CloneRepoInput) =>
			request<{ repo: Repo }>("/api/repos", {
				method: "POST",
				body: JSON.stringify(input),
			}),
		delete: (id: string) =>
			request<{ ok: boolean; id: string }>(`/api/repos/${id}`, {
				method: "DELETE",
			}),
	},
	sessions: {
		listByRepo: (repoId: string) =>
			request<{ sessions: SessionView[] }>(
				`/api/sessions?repoId=${encodeURIComponent(repoId)}`,
			),
		get: (id: string) =>
			request<{ session: SessionView }>(`/api/sessions/${id}`),
		create: (repoId: string, agentType?: AgentType) =>
			request<{ session: SessionView }>("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ repoId, agentType }),
			}),
		delete: (id: string) =>
			request<{ ok: boolean; id: string }>(`/api/sessions/${id}`, {
				method: "DELETE",
			}),
		messages: (id: string) =>
			request<{ messages: Message[] }>(`/api/sessions/${id}/messages`),
		changedFiles: (id: string) =>
			request<{ files: ChangedFile[] }>(`/api/sessions/${id}/changed-files`),
		send: (id: string, text: string) =>
			request<{ ok: boolean }>(`/api/sessions/${id}/messages`, {
				method: "POST",
				body: JSON.stringify({ text }),
			}),
		stop: (id: string) =>
			request<{ ok: boolean; id: string }>(`/api/sessions/${id}/stop`, {
				method: "POST",
			}),
		/** Subscribe to a session's live SSE stream. Returns an unsubscribe. */
		stream: (
			id: string,
			onEvent: (event: AgentStreamEvent) => void,
		): (() => void) => {
			const es = new EventSource(`/api/sessions/${id}/stream`);
			const eventTypes = [
				"session_status",
				"message_start",
				"token",
				"tool_call_start",
				"tool_call_end",
				"message_end",
				"error",
				"agent_crashed",
				"changed_files",
				"usage_update",
			];
			for (const t of eventTypes) {
				es.addEventListener(t, (e: MessageEvent) => {
					try {
						const ev = JSON.parse(e.data as string) as AgentStreamEvent;
						onEvent(ev);
					} catch {
						// ignore malformed payloads
					}
				});
			}
			return () => es.close();
		},
	},
	/** Cross-session status stream (per ADR-0008): one subscription per app
	 * load, notified whenever any session's status changes. Powers the
	 * sidebar's Background Agents panel and the chat header's session
	 * dropdown. Returns an unsubscribe. */
	sessionList: {
		stream: (onEvent: (event: SessionListEvent) => void): (() => void) => {
			const es = new EventSource("/api/stream");
			for (const t of ["session_status", "session_deleted"]) {
				es.addEventListener(t, (e: MessageEvent) => {
					try {
						const ev = JSON.parse(e.data as string) as SessionListEvent;
						onEvent(ev);
					} catch {
						// ignore malformed payloads
					}
				});
			}
			return () => es.close();
		},
	},
};
