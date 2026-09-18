import type {
	AgentStreamEvent,
	AgentType,
	ArtefactsResponse,
	Attachment,
	AttachmentResponse,
	CancelOAuthBody,
	ChangedFile,
	ChangedFilesResponse,
	ClearOverrideResponse,
	CloneRepoBody,
	CommitInfo,
	CommitsResponse,
	CompleteOAuthBody,
	CreateCustomProviderBody,
	CreateSessionBody,
	CustomModelDef,
	CustomProviderApi,
	CustomProviderFields,
	CustomProviderView,
	DiskUsage,
	DiskUsageResponse,
	InstallSkillBody,
	InstallSkillResponse,
	ListQueuedResponse,
	ListRepoSkillsResponse,
	ListReposResponse,
	ListSessionsResponse,
	ListSkillsResponse,
	LlmConfig,
	Message,
	OauthStartResponse,
	OkIdResponse,
	OkResponse,
	ProviderModelOption,
	PushKeyResponse,
	PushSubscribeBody,
	PushSubscriptionsResponse,
	PushUnsubscribeBody,
	QueuedMessage,
	QueueMessageResponse,
	RateLimitWindow,
	Repo,
	RepoResponse,
	RepoSkill,
	RepoStats,
	RepoStatsResponse,
	RepoSyncResponse,
	RepoSyncStatus,
	SearchSkillsResponse,
	SendMessageBody,
	SendMessageResponse,
	SessionListEvent,
	SessionMessagesResponse,
	SessionResponse,
	SessionView,
	SetCredentialBody,
	SetOverrideResponse,
	SetProviderOverrideBody,
	SetSkillEnabledBody,
	Skill,
	SkillSearchResult,
	UsageSummary,
	UsageSummaryResponse,
} from "@dilna/shared";
import { encodeSkillId, isApiErrorBody, paths } from "@dilna/shared";
import { SessionStreamHub } from "./sessionStream";

// `LlmConfig`, `CustomProviderView`, `ProviderModelOption` and the request
// body types below are no longer declared here: they live in
// `@dilna/shared`'s apiSchemas.ts alongside the Zod schemas the server
// validates with. `LlmConfig` in particular used to be a hand-maintained
// twin of the server's `GetConfigResponse` and had already drifted — this
// side typed a custom provider's `api` as a bare `string` where the server
// had a four-literal union.
//
// The `*Response` types are the same idea applied to every other endpoint
// (ADR-0040): each call below names the envelope its route annotates rather
// than restating its shape in a `request<{ ... }>` generic. Three of those
// hand-written generics had drifted from the server before they were
// replaced — see the ADR for which.
export type {
	AgentStreamEvent,
	AgentType,
	ChangedFile,
	CommitInfo,
	CustomProviderApi,
	CustomProviderView,
	DiskUsage,
	LlmConfig,
	Message,
	ProviderModelOption,
	QueuedMessage,
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

/** @deprecated Prefer `CustomModelDef` from `@dilna/shared`; kept as an alias
 * so existing Settings-view imports keep resolving. */
export type CustomModelInput = CustomModelDef;

export type CloneRepoInput = CloneRepoBody;

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

/**
 * The per-Session fan-out (issue #202), wired to the real `EventSource`
 * transport. Module-level so every `api.sessions.stream` caller for a given
 * Session lands on the same connection.
 */
const sessionStreamHub = new SessionStreamHub(
	(sessionId, eventTypes, onEvent, onOpen, onConnectionChange) =>
		openEventStream<AgentStreamEvent>(
			paths.sessions.stream(sessionId),
			eventTypes,
			onEvent,
			onOpen,
			onConnectionChange,
		),
);

/**
 * URL that serves an attachment's bytes — what an `<img src>` points at, and
 * the link target for a document card.
 *
 * A plain relative path rather than a `fetch` wrapper: the browser has to
 * load these itself (an `<img>` can't go through {@link request}), and the
 * route sets a long immutable `Cache-Control` so repeated renders of a
 * message list don't refetch the same image.
 */
export function attachmentUrl(sessionId: string, attachmentId: string): string {
	return paths.sessions.attachment(sessionId, attachmentId);
}

/**
 * URL that serves a published artefact's bytes — the `<iframe src>` for the
 * preview and the link target for "open in new tab".
 *
 * Relative, like {@link attachmentUrl}, and for the same reason: the browser
 * loads it directly rather than through {@link request}. The response carries
 * a restrictive CSP that confines whatever the Agent generated (see the
 * server route and ADR-0032) — this URL is safe to put in an iframe, but not
 * because of anything on this side.
 */
export function artefactUrl(sessionId: string, artefactId: string): string {
	return paths.sessions.artefact(sessionId, artefactId);
}

export class ApiError extends Error {
	constructor(
		public status: number,
		public body: unknown,
		message: string,
		/** Per-field validation messages on a 422, so a form can mark the
		 * offending inputs rather than showing one opaque string. */
		public fieldErrors?: Record<string, string[]>,
	) {
		super(message);
	}
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	// A `FormData` body must carry the browser-generated multipart boundary in
	// its `Content-Type`, which only happens if the header is left unset —
	// forcing `application/json` here (the default for every other call) makes
	// the server unable to parse the upload at all.
	const isFormData = init?.body instanceof FormData;
	const res = await fetch(path, {
		...init,
		headers: {
			...(isFormData ? {} : { "Content-Type": "application/json" }),
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
		// Every server failure now arrives as `@dilna/shared`'s envelope
		// (`{ error: { message, status, fieldErrors? } }`), applied by the
		// server's `app.onError` + the `validate` hook. Before that existed the
		// server emitted four different shapes — including plain text, which
		// this function couldn't read at all — so a real message like "repo not
		// found" always surfaced as the generic fallback below.
		if (isApiErrorBody(body)) {
			throw new ApiError(
				res.status,
				body,
				body.error.message,
				body.error.fieldErrors,
			);
		}
		throw new ApiError(res.status, body, `request failed (${res.status})`);
	}
	return body as T;
}

export const api = {
	repos: {
		list: () => request<ListReposResponse>(paths.repos.list()),
		get: (id: string) => request<RepoResponse>(paths.repos.get(id)),
		clone: (input: CloneRepoBody) =>
			request<RepoResponse>(paths.repos.list(), {
				method: "POST",
				body: JSON.stringify(input),
			}),
		pull: (id: string) =>
			request<RepoResponse>(paths.repos.pull(id), { method: "POST" }),
		stats: (id: string) => request<RepoStatsResponse>(paths.repos.stats(id)),
		sync: (id: string) =>
			request<RepoSyncResponse>(paths.repos.sync(id), {
				method: "POST",
			}),
		delete: (id: string) =>
			request<OkIdResponse>(paths.repos.get(id), {
				method: "DELETE",
			}),
	},
	sessions: {
		listByRepo: (repoId: string) =>
			request<ListSessionsResponse>(paths.sessions.list(repoId)),
		get: (id: string) => request<SessionResponse>(paths.sessions.get(id)),
		create: (repoId: string, agentType?: AgentType) => {
			// Named against the shared schema (ADR-0039) rather than an
			// anonymous literal, so a field rename on the server is a compile
			// error here instead of a 422 at runtime.
			const body: CreateSessionBody = { repoId, agentType };
			return request<SessionResponse>(paths.sessions.list(), {
				method: "POST",
				body: JSON.stringify(body),
			});
		},
		createOrchestrator: () =>
			request<SessionResponse>(paths.sessions.orchestrator(), {
				method: "POST",
			}),
		delete: (id: string) =>
			request<OkIdResponse>(paths.sessions.get(id), {
				method: "DELETE",
			}),
		messages: (id: string) =>
			request<SessionMessagesResponse>(paths.sessions.messages(id)),
		changedFiles: (id: string) =>
			request<ChangedFilesResponse>(paths.sessions.changedFiles(id)),
		commits: (id: string) =>
			request<CommitsResponse>(paths.sessions.commits(id)),
		artefacts: (id: string) =>
			request<ArtefactsResponse>(paths.sessions.artefacts(id)),
		send: (id: string, text: string, attachmentIds?: string[]) =>
			request<SendMessageResponse>(paths.sessions.messages(id), {
				method: "POST",
				body: JSON.stringify(sendBody(text, attachmentIds)),
			}),
		/** Upload one file to a session, before the message that references it
		 * is sent. Multipart rather than JSON, so the bytes aren't base64-inflated
		 * on the way up; `Content-Type` is deliberately left unset so the browser
		 * supplies the multipart boundary. */
		uploadAttachment: async (id: string, file: File): Promise<Attachment> => {
			const form = new FormData();
			form.append("file", file);
			const { attachment } = await request<AttachmentResponse>(
				paths.sessions.attachments(id),
				{ method: "POST", body: form },
			);
			return attachment;
		},
		/** Enqueue a message submitted while a turn is in flight (ADR-0033).
		 * Stored server-side and dispatched at the next turn boundary, so it
		 * survives a locked phone or closed tab. Same body shape as `send`. */
		queueMessage: (id: string, text: string, attachmentIds?: string[]) =>
			request<QueueMessageResponse>(paths.sessions.queue(id), {
				method: "POST",
				body: JSON.stringify(sendBody(text, attachmentIds)),
			}),
		/** The queue's initial snapshot — fetched by the on-open resync, then
		 * kept live via `queue_update` stream events. */
		queuedMessages: (id: string) =>
			request<ListQueuedResponse>(paths.sessions.queue(id)),
		/** Withdraw a queued entry before it dispatches. Idempotent on the
		 * server — an entry that already drained into a turn is still `ok`. */
		removeQueuedMessage: (id: string, queuedId: string) =>
			request<OkResponse>(paths.sessions.queuedMessage(id, queuedId), {
				method: "DELETE",
			}),
		stop: (id: string) =>
			request<OkIdResponse>(paths.sessions.stop(id), {
				method: "POST",
			}),
		/** Absolute URL to the session's full-transcript export (server route,
		 * unauthenticated like the rest of the API) — copy-to-clipboard target
		 * for handing a session's history to another agent. */
		transcriptUrl: (id: string) =>
			new URL(paths.sessions.transcript(id), window.location.origin).toString(),
		/** Subscribe to a session's live SSE stream.
		 *
		 * Multiple subscribers to the same `id` share one `EventSource` via
		 * {@link sessionStreamHub} (issue #202) — the connection opens on the
		 * first subscriber and closes on the last, so N consumers cost one
		 * socket and one server-side subscriber rather than N of each.
		 *
		 * `onOpen` runs on first connect and every reconnect (native retry or
		 * the liveness-driven one) — the single resync point (ADR-0016 §4): the
		 * caller resets its live-turn state and refetches history there. It also
		 * runs immediately if you subscribe to an already-open connection, since
		 * a late subscriber has missed just as much as a reconnecting one.
		 * `onConnectionChange` reports degraded/recovered for a "reconnecting…"
		 * indicator. Returns an unsubscribe. */
		stream: (
			id: string,
			onEvent: (event: AgentStreamEvent) => void,
			onOpen?: () => void,
			onConnectionChange?: (connected: boolean) => void,
		): (() => void) =>
			sessionStreamHub.subscribe(id, {
				onEvent,
				onOpen,
				onConnectionChange,
			}),
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
				paths.stream(),
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
			request<UsageSummaryResponse>(
				paths.usage.summary(days === "all" ? undefined : days),
			),
		/** Live filesystem capacity for the `DILNA_DATA_DIR` volume (read via
		 * `fs.statfs` on the server) — backs the Metrics page's storage card. */
		disk: () => request<DiskUsageResponse>(paths.usage.disk()),
	},
	config: {
		/** Current provider/model + override state for the Settings view. */
		get: () => request<LlmConfig>(paths.config.get()),
		/** Persist a single provider/model override (replaces any existing). */
		setOverride: (provider: string, model: string) => {
			const body: SetProviderOverrideBody = { provider, model };
			return request<SetOverrideResponse>(paths.config.get(), {
				method: "PUT",
				body: JSON.stringify(body),
			});
		},
		/** Drop the override so provider/model fall back to the env vars. */
		clearOverride: () =>
			request<ClearOverrideResponse>(paths.config.get(), {
				method: "DELETE",
			}),
		/** Save (replace) a provider's API key — multi-provider support (see
		 * the Settings "Add a provider" flow). */
		setCredential: (provider: string, apiKey: string) => {
			const body: SetCredentialBody = { provider, apiKey };
			return request<OkResponse>(paths.config.credentials(), {
				method: "PUT",
				body: JSON.stringify(body),
			});
		},
		/** Forget a provider's stored API key (falls back to its env key). */
		deleteCredential: (provider: string) =>
			request<OkResponse>(paths.config.credential(provider), {
				method: "DELETE",
			}),
		/** Begin an Anthropic "Sign in with Claude" OAuth login — returns a URL
		 * to open plus a `loginId` to complete it with once the user pastes back
		 * the resulting code/redirect URL (see providerOAuth.ts). */
		startAnthropicOAuthLogin: () =>
			request<OauthStartResponse>(paths.config.anthropicOauthStart(), {
				method: "POST",
			}),
		/** Finish a pending login with the pasted code/redirect URL. */
		completeAnthropicOAuthLogin: (loginId: string, input: string) => {
			const body: CompleteOAuthBody = { loginId, input };
			return request<OkResponse>(paths.config.anthropicOauthComplete(), {
				method: "POST",
				body: JSON.stringify(body),
			});
		},
		/** Abandon a pending login (e.g. the dialog was closed unsubmitted). */
		cancelAnthropicOAuthLogin: (loginId: string) => {
			const body: CancelOAuthBody = { loginId };
			return request<OkResponse>(paths.config.anthropicOauthCancel(), {
				method: "POST",
				body: JSON.stringify(body),
			});
		},
		/** Disconnect Anthropic's OAuth login (falls back to a stored API key or
		 * env thereafter). */
		disconnectAnthropicOAuth: () =>
			request<OkResponse>(paths.config.anthropicOauth(), {
				method: "DELETE",
			}),
		/** Create a custom provider (Ollama, LM Studio, vLLM, ...), plus its API
		 * key when one is given. */
		createCustomProvider: (input: CreateCustomProviderBody) =>
			request<OkResponse>(paths.config.customProviders(), {
				method: "POST",
				body: JSON.stringify(input),
			}),
		/** Update a custom provider's definition; the id is immutable. Replaces
		 * the stored key only when a non-empty `apiKey` is sent. */
		updateCustomProvider: (id: string, input: CustomProviderFields) =>
			request<OkResponse>(paths.config.customProvider(id), {
				method: "PUT",
				body: JSON.stringify(input),
			}),
		/** Delete a custom provider and its stored key. */
		deleteCustomProvider: (id: string) =>
			request<OkResponse>(paths.config.customProvider(id), {
				method: "DELETE",
			}),
	},
	/** Skill management (issue #60): skills install globally, then get
	 * enabled per-Repo — there's only ever one copy of a skill on disk. */
	skills: {
		/** The global catalog: every installed skill. */
		list: () => request<ListSkillsResponse>(paths.skills.list()),
		/** The catalog, flagged with whether `repoId` has each one enabled. */
		forRepo: (repoId: string) =>
			request<ListRepoSkillsResponse>(paths.skills.forRepo(repoId)),
		/** Search skills.sh. Returns `[]` if the registry is unreachable. */
		search: (q: string) =>
			request<SearchSkillsResponse>(paths.skills.search(q)),
		/** Install globally from a skills.sh/GitHub URL. Does not enable it. */
		install: (url: string) => {
			const body: InstallSkillBody = { url };
			return request<InstallSkillResponse>(paths.skills.list(), {
				method: "POST",
				body: JSON.stringify(body),
			});
		},
		/** Turn a skill on/off for one Repo. `id` (`{source}/{slug}`) is
		 * base64url-encoded into one path segment — see encodeSkillId's doc
		 * comment for why (an edge in front of the deployment can decode a
		 * plain `%2F` back into `/` and redirect, so the id can't contain a
		 * `/` at all, not even percent-encoded). */
		setEnabled: (id: string, repoId: string, enabled: boolean) => {
			const body: SetSkillEnabledBody = { repoId, enabled };
			return request<OkResponse>(paths.skills.enabled(encodeSkillId(id)), {
				method: "POST",
				body: JSON.stringify(body),
			});
		},
		/** Uninstall globally — files, catalog row, all enablement rows. */
		uninstall: (id: string) =>
			request<OkResponse>(paths.skills.item(encodeSkillId(id)), {
				method: "DELETE",
			}),
	},
	/** Web Push subscription management (ADR-0029). */
	push: {
		/** The instance VAPID public key needed by `pushManager.subscribe`.
		 * `configured: false` means push is unavailable, not that it errored. */
		key: () => request<PushKeyResponse>(paths.push.key()),
		/** `subscription` is the browser's `PushSubscriptionJSON`; the keys
		 * `endpoint`/`p256dh`/`auth` are what `PushSubscribeBody` declares.
		 * Named here so the two are checked against each other — the DOM type
		 * has every field optional, so it permits a call the server would 422. */
		subscribe: (subscription: PushSubscribeBody) =>
			request<PushSubscriptionsResponse>(paths.push.subscribe(), {
				method: "POST",
				body: JSON.stringify(subscription),
			}),
		unsubscribe: (endpoint: string) => {
			const body: PushUnsubscribeBody = { endpoint };
			return request<PushSubscriptionsResponse>(paths.push.unsubscribe(), {
				method: "POST",
				body: JSON.stringify(body),
			});
		},
	},
};

/** The send/queue body, built once for both callers rather than written twice.
 * Omits `attachmentIds` entirely when empty so a text-only send puts exactly
 * the same bytes on the wire it always has. */
function sendBody(text: string, attachmentIds?: string[]): SendMessageBody {
	return attachmentIds?.length ? { text, attachmentIds } : { text };
}
