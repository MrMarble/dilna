import type {
	AgentStreamEvent,
	AgentType,
	ChangedFile,
	CommitInfo,
	ContextUsageEstimate,
	DiskUsage,
	Message,
	RateLimitWindow,
	Repo,
	RepoSkill,
	RepoStats,
	RepoSyncStatus,
	SessionListEvent,
	SessionView,
	Skill,
	SkillSearchResult,
	UsageSummary,
} from "@dilna/shared";
import { encodeSkillId } from "@dilna/shared";

export type {
	AgentStreamEvent,
	AgentType,
	ChangedFile,
	CommitInfo,
	DiskUsage,
	Message,
	RateLimitWindow,
	Repo,
	RepoSkill,
	RepoStats,
	RepoSyncStatus,
	SessionListEvent,
	SessionView,
	Skill,
	SkillSearchResult,
	UsageSummary,
};

export type CloneRepoInput = {
	url: string;
	slug?: string;
};

/** A single model option shown in the LLM Settings dropdown. */
export type ProviderModelOption = {
	id: string;
	name: string;
};

/** A model entry on a custom provider — see apps/server/src/agents/customProviders.ts. */
export type CustomModelInput = { id: string; name?: string };

/** A user-defined provider (Ollama, LM Studio, vLLM, ...) — see
 * apps/server/src/agents/customProviders.ts. No key material included. */
export type CustomProviderView = {
	id: string;
	name: string;
	baseUrl: string;
	api: string;
	models: CustomModelInput[];
};

/** Server `/api/config` GET response — see apps/server/src/routes/config.ts. */
export type LlmConfig = {
	override: { provider: string; model: string } | null;
	envDefault: { provider: string; model: string };
	effective: { provider: string; model: string };
	apiKeysConfigured: Record<string, boolean>;
	/** Providers that have a **stored** (Settings-added) API key — see the
	 * server's providerCredentials.ts. Provider ids only; key material never
	 * leaves the server. */
	keyedStoredProviders: { provider: string }[];
	modelsByProvider: Record<string, ProviderModelOption[]>;
	/** Providers with a connected OAuth login ("Sign in with Claude") — today
	 * only ever `{ anthropic: boolean }`. An OAuth login outranks a stored API
	 * key for the same provider. */
	oauthConnected: Record<string, boolean>;
	/** User-defined providers — already folded into `modelsByProvider`/
	 * `apiKeysConfigured` above, this is only for the "Custom providers"
	 * management section. */
	customProviders: CustomProviderView[];
};

const SESSION_EVENT_TYPES: AgentStreamEvent["type"][] = [
	"session_status",
	"changed_files",
	"user_message",
	"message_start",
	"token",
	"thinking",
	"tool_call_start",
	"tool_call_end",
	"message_end",
	"turn_failed",
	"notice",
	"turn_activity",
	"resync",
	"usage_update",
];

const SESSION_LIST_EVENT_TYPES: SessionListEvent["type"][] = [
	"session_status",
	"session_deleted",
	"rate_limits",
];

/** ~2x the server's ~15s ping (routes/sse.ts's PING_INTERVAL_MS) — silence
 * past this means the connection is open but not actually alive (ADR-0016
 * §4). Checked on a plain interval rather than a single timer that's reset
 * per-event, which is simpler and only 5s coarser. */
const STALE_AFTER_MS = 30_000;
const STALE_CHECK_INTERVAL_MS = 5_000;
const RECONNECT_BACKOFF_MIN_MS = 1_000;
const RECONNECT_BACKOFF_MAX_MS = 30_000;

/**
 * Own an `EventSource` with reconnect-on-silence (ADR-0016 §4), for both the
 * per-session stream and the cross-session `/api/stream`: native
 * `EventSource` retry already covers an actual connection drop, but not one
 * that stays open while the server (or something between client and server)
 * has gone quiet — this is the "open but not alive" case the `ping` event
 * exists to detect. `onOpen` is the single resync point, firing on the first
 * connect, every native retry, and every reconnect this function forces —
 * callers reset their live-turn state and refetch history there rather than
 * trying to patch in whatever was missed.
 */
function openEventStream<T>(
	url: string,
	eventTypes: readonly string[],
	onEvent: (event: T) => void,
	onOpen?: () => void,
	onConnectionChange?: (connected: boolean) => void,
): () => void {
	let es: EventSource | null = null;
	let closed = false;
	let lastEventAt = Date.now();
	let backoffMs = RECONNECT_BACKOFF_MIN_MS;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	const connect = () => {
		if (closed) return;
		const source = new EventSource(url);
		es = source;
		lastEventAt = Date.now();

		source.addEventListener("open", () => {
			backoffMs = RECONNECT_BACKOFF_MIN_MS;
			lastEventAt = Date.now();
			onConnectionChange?.(true);
			onOpen?.();
		});
		source.addEventListener("ping", () => {
			lastEventAt = Date.now();
		});
		for (const t of eventTypes) {
			source.addEventListener(t, (e: MessageEvent) => {
				lastEventAt = Date.now();
				try {
					const ev = JSON.parse(e.data as string) as T;
					onEvent(ev);
				} catch {
					// ignore malformed payloads
				}
			});
		}
		source.addEventListener("error", () => {
			// Native retry handles the reconnect itself; this only flags the
			// connection as degraded for the UI. The staleness check below is
			// what forces a reconnect for a silent-but-open connection.
			onConnectionChange?.(false);
		});
	};

	connect();

	const staleTimer = setInterval(() => {
		if (closed || !es) return;
		if (Date.now() - lastEventAt > STALE_AFTER_MS) {
			onConnectionChange?.(false);
			es.close();
			const delay = backoffMs;
			backoffMs = Math.min(backoffMs * 2, RECONNECT_BACKOFF_MAX_MS);
			reconnectTimer = setTimeout(connect, delay);
		}
	}, STALE_CHECK_INTERVAL_MS);

	return () => {
		closed = true;
		clearInterval(staleTimer);
		if (reconnectTimer) clearTimeout(reconnectTimer);
		es?.close();
	};
}

export class ApiError extends Error {
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
		pull: (id: string) =>
			request<{ repo: Repo }>(`/api/repos/${id}/pull`, { method: "POST" }),
		stats: (id: string) =>
			request<{ stats: RepoStats }>(`/api/repos/${id}/stats`),
		sync: (id: string) =>
			request<{ status: RepoSyncStatus }>(`/api/repos/${id}/sync`, {
				method: "POST",
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
			request<{
				session: SessionView;
				contextUsage: ContextUsageEstimate | null;
			}>(`/api/sessions/${id}`),
		create: (repoId: string, agentType?: AgentType) =>
			request<{ session: SessionView }>("/api/sessions", {
				method: "POST",
				body: JSON.stringify({ repoId, agentType }),
			}),
		createOrchestrator: () =>
			request<{ session: SessionView }>("/api/sessions/orchestrator", {
				method: "POST",
			}),
		delete: (id: string) =>
			request<{ ok: boolean; id: string }>(`/api/sessions/${id}`, {
				method: "DELETE",
			}),
		messages: (id: string) =>
			request<{ messages: Message[] }>(`/api/sessions/${id}/messages`),
		changedFiles: (id: string) =>
			request<{ files: ChangedFile[] }>(`/api/sessions/${id}/changed-files`),
		commits: (id: string) =>
			request<{ commits: CommitInfo[] }>(`/api/sessions/${id}/commits`),
		send: (id: string, text: string) =>
			request<{ ok: boolean; message: Message }>(
				`/api/sessions/${id}/messages`,
				{
					method: "POST",
					body: JSON.stringify({ text }),
				},
			),
		stop: (id: string) =>
			request<{ ok: boolean; id: string }>(`/api/sessions/${id}/stop`, {
				method: "POST",
			}),
		/** Absolute URL to the session's full-transcript export (server route,
		 * unauthenticated like the rest of the API) — copy-to-clipboard target
		 * for handing a session's history to another agent. */
		transcriptUrl: (id: string) =>
			new URL(
				`/api/sessions/${id}/transcript`,
				window.location.origin,
			).toString(),
		/** Subscribe to a session's live SSE stream. `onOpen` runs on first
		 * connect and every reconnect (native retry or this function's own
		 * liveness-driven one) — the single resync point (ADR-0016 §4): the
		 * caller resets its live-turn state and refetches history there.
		 * `onConnectionChange` reports degraded/recovered for a "reconnecting…"
		 * indicator. Returns an unsubscribe. */
		stream: (
			id: string,
			onEvent: (event: AgentStreamEvent) => void,
			onOpen?: () => void,
			onConnectionChange?: (connected: boolean) => void,
		): (() => void) =>
			openEventStream(
				`/api/sessions/${id}/stream`,
				SESSION_EVENT_TYPES,
				onEvent,
				onOpen,
				onConnectionChange,
			),
	},
	/** Cross-session status stream (per ADR-0008): one subscription per app
	 * load, notified whenever any session's status changes. Powers the
	 * sidebar's Background Agents panel and the chat header's session
	 * dropdown. Same reconnect-on-silence handling as `sessions.stream`
	 * (ADR-0016 §4 applies to both streams). Returns an unsubscribe. */
	sessionList: {
		stream: (
			onEvent: (event: SessionListEvent) => void,
			onOpen?: () => void,
			onConnectionChange?: (connected: boolean) => void,
		): (() => void) =>
			openEventStream(
				"/api/stream",
				SESSION_LIST_EVENT_TYPES,
				onEvent,
				onOpen,
				onConnectionChange,
			),
	},
	usage: {
		/** `days` selects the lookback window; omit (or pass `"all"`) for
		 * all-time. Backs the Metrics page's range selector. */
		summary: (days?: number | "all") =>
			request<{ summary: UsageSummary }>(
				`/api/usage${days !== undefined ? `?days=${days}` : ""}`,
			),
		/** Live filesystem capacity for the `DILNA_DATA_DIR` volume (read via
		 * `fs.statfs` on the server) — backs the Metrics page's storage card. */
		disk: () => request<{ disk: DiskUsage }>("/api/usage/disk"),
	},
	config: {
		/** Current provider/model + override state for the Settings view. */
		get: () => request<LlmConfig>("/api/config"),
		/** Persist a single provider/model override (replaces any existing). */
		setOverride: (provider: string, model: string) =>
			request<{
				ok: boolean;
				override: { provider: string; model: string } | null;
			}>("/api/config", {
				method: "PUT",
				body: JSON.stringify({ provider, model }),
			}),
		/** Drop the override so provider/model fall back to the env vars. */
		clearOverride: () =>
			request<{ ok: boolean; override: null }>("/api/config", {
				method: "DELETE",
			}),
		/** Save (replace) a provider's API key — multi-provider support (see
		 * the Settings "Add a provider" flow). */
		setCredential: (provider: string, apiKey: string) =>
			request<{ ok: boolean }>("/api/config/credentials", {
				method: "PUT",
				body: JSON.stringify({ provider, apiKey }),
			}),
		/** Forget a provider's stored API key (falls back to its env key). */
		deleteCredential: (provider: string) =>
			request<{ ok: boolean }>(
				`/api/config/credentials/${encodeURIComponent(provider)}`,
				{
					method: "DELETE",
				},
			),
		/** Begin an Anthropic "Sign in with Claude" OAuth login — returns a URL
		 * to open plus a `loginId` to complete it with once the user pastes back
		 * the resulting code/redirect URL (see providerOAuth.ts). */
		startAnthropicOAuthLogin: () =>
			request<{ loginId: string; authUrl: string }>(
				"/api/config/providers/anthropic/oauth/start",
				{ method: "POST" },
			),
		/** Finish a pending login with the pasted code/redirect URL. */
		completeAnthropicOAuthLogin: (loginId: string, input: string) =>
			request<{ ok: boolean }>(
				"/api/config/providers/anthropic/oauth/complete",
				{ method: "POST", body: JSON.stringify({ loginId, input }) },
			),
		/** Abandon a pending login (e.g. the dialog was closed unsubmitted). */
		cancelAnthropicOAuthLogin: (loginId: string) =>
			request<{ ok: boolean }>("/api/config/providers/anthropic/oauth/cancel", {
				method: "POST",
				body: JSON.stringify({ loginId }),
			}),
		/** Disconnect Anthropic's OAuth login (falls back to a stored API key or
		 * env thereafter). */
		disconnectAnthropicOAuth: () =>
			request<{ ok: boolean }>("/api/config/providers/anthropic/oauth", {
				method: "DELETE",
			}),
		/** Create a custom provider (Ollama, LM Studio, vLLM, ...), plus its API
		 * key when one is given. */
		createCustomProvider: (input: {
			id: string;
			name: string;
			baseUrl: string;
			api: string;
			apiKey?: string;
			models: CustomModelInput[];
		}) =>
			request<{ ok: boolean }>("/api/config/custom-providers", {
				method: "POST",
				body: JSON.stringify(input),
			}),
		/** Update a custom provider's definition; the id is immutable. Replaces
		 * the stored key only when a non-empty `apiKey` is sent. */
		updateCustomProvider: (
			id: string,
			input: {
				name: string;
				baseUrl: string;
				api: string;
				apiKey?: string;
				models: CustomModelInput[];
			},
		) =>
			request<{ ok: boolean }>(
				`/api/config/custom-providers/${encodeURIComponent(id)}`,
				{ method: "PUT", body: JSON.stringify(input) },
			),
		/** Delete a custom provider and its stored key. */
		deleteCustomProvider: (id: string) =>
			request<{ ok: boolean }>(
				`/api/config/custom-providers/${encodeURIComponent(id)}`,
				{ method: "DELETE" },
			),
	},
	/** Skill management (issue #60): skills install globally, then get
	 * enabled per-Repo — there's only ever one copy of a skill on disk. */
	skills: {
		/** The global catalog: every installed skill. */
		list: () => request<{ skills: Skill[] }>("/api/skills"),
		/** The catalog, flagged with whether `repoId` has each one enabled. */
		forRepo: (repoId: string) =>
			request<{ skills: RepoSkill[] }>(`/api/skills/repo/${repoId}`),
		/** Search skills.sh. Returns `[]` if the registry is unreachable. */
		search: (q: string) =>
			request<{ results: SkillSearchResult[] }>(
				`/api/skills/search?q=${encodeURIComponent(q)}`,
			),
		/** Install globally from a skills.sh/GitHub URL. Does not enable it. */
		install: (url: string) =>
			request<{ skill: Skill }>("/api/skills", {
				method: "POST",
				body: JSON.stringify({ url }),
			}),
		/** Turn a skill on/off for one Repo. `id` (`{source}/{slug}`) is
		 * base64url-encoded into one path segment — see encodeSkillId's doc
		 * comment for why (an edge in front of the deployment can decode a
		 * plain `%2F` back into `/` and redirect, so the id can't contain a
		 * `/` at all, not even percent-encoded). */
		setEnabled: (id: string, repoId: string, enabled: boolean) =>
			request<{ ok: boolean }>(`/api/skills/${encodeSkillId(id)}/enabled`, {
				method: "POST",
				body: JSON.stringify({ repoId, enabled }),
			}),
		/** Uninstall globally — files, catalog row, all enablement rows. */
		uninstall: (id: string) =>
			request<{ ok: boolean }>(`/api/skills/${encodeSkillId(id)}`, {
				method: "DELETE",
			}),
	},
};
