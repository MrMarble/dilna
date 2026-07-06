import type { Repo, SessionView } from "@dilna/shared";

export type { Repo, SessionView };

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
		create: (repoId: string) =>
			request<{ session: SessionView }>("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ repoId }),
			}),
		delete: (id: string) =>
			request<{ ok: boolean; id: string }>(`/api/sessions/${id}`, {
				method: "DELETE",
			}),
	},
};
