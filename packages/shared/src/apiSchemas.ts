import { z } from "zod";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "./messages";

/**
 * Request schemas for dilna's HTTP API, owned here rather than per-route so
 * the server validates and the web client types against the *same*
 * definition (ADR-0001's "cross-package changes go through
 * `packages/shared`", applied to request bodies rather than just domain
 * types).
 *
 * Response *envelopes* now live in `apiResponses.ts` (ADR-0040); `LlmConfig`
 * below stays here because it is assembled from the custom-provider schemas
 * next to it. Domain shapes
 * themselves (`Repo`, `SessionView`, `Message`, ...) stay as plain
 * TypeScript types in their own modules — they're produced by the server
 * from the DB and never parsed from untrusted input, so a runtime schema for
 * them would be cost without benefit. The rule is: **schema what crosses the
 * wire inbound, type what goes out.**
 */

// ---- Repos -----------------------------------------------------------------

export const cloneRepoBodySchema = z.object({
	url: z.string().min(1, "a git URL is required"),
	slug: z.string().min(1).optional(),
});
export type CloneRepoBody = z.infer<typeof cloneRepoBodySchema>;

// ---- Sessions --------------------------------------------------------------

/** `agentType` is validated structurally against the full shared union; the
 * server's `CREATABLE_AGENT_TYPES` still gates which of those are actually
 * creatable ("openai" is a reserved placeholder, not yet implemented). */
export const createSessionBodySchema = z.object({
	repoId: z.string().min(1),
	agentType: z.enum(["pi", "openai"]).optional(),
});
export type CreateSessionBody = z.infer<typeof createSessionBodySchema>;

export const sendMessageBodySchema = z
	.object({
		// Empty is allowed at the field level so an attachment-only message
		// ("look at this") can be sent; the refinement below still rejects a
		// send that carries neither text nor files.
		text: z.string().max(200_000),
		/** Ids from `POST /:id/attachments`, in the order the composer showed
		 * them. Resolved and ownership-checked before the turn is claimed. Bounded
		 * by the same shared constant the resolver and the composer use, so a send
		 * can't pass validation here only to be rejected downstream for a limit
		 * this schema disagreed about. */
		attachmentIds: z
			.array(z.string().min(1))
			.max(MAX_ATTACHMENTS_PER_MESSAGE)
			.optional(),
	})
	.refine((body) => body.text.trim().length > 0 || body.attachmentIds?.length, {
		message: "a message needs text or at least one attachment",
	});
export type SendMessageBody = z.infer<typeof sendMessageBodySchema>;

/** `GET /api/sessions` — `repoId` was previously only checked for truthiness. */
export const listSessionsQuerySchema = z.object({
	repoId: z.string().min(1, "repoId query param is required"),
});

/**
 * `GET /api/sessions/:id/commits` — the bound matches the previous
 * hand-rolled `parseCommitsLimit`: a non-integer or out-of-range value falls
 * back to the route's default rather than erroring, which is why this
 * `catch`es instead of failing.
 */
export const commitsQuerySchema = z.object({
	limit: z.coerce.number().int().positive().max(50).optional().catch(undefined),
});

// ---- Usage -----------------------------------------------------------------

/**
 * `GET /api/usage` — `days` is either the literal "all" or a positive
 * integer. Previously `Number(days)` ran unguarded, so `?days=abc` produced
 * `NaN` and passed it straight into `getUsageSummary(since)`.
 */
export const usageQuerySchema = z.object({
	days: z
		.union([z.literal("all"), z.coerce.number().int().positive().max(3650)])
		.optional(),
});
export type UsageQuery = z.infer<typeof usageQuerySchema>;

// ---- Skills ----------------------------------------------------------------

export const installSkillBodySchema = z.object({
	/** A skills.sh or GitHub URL, or `owner/repo/skill` shorthand. */
	url: z.string().min(1),
});
export type InstallSkillBody = z.infer<typeof installSkillBodySchema>;

/** `GET /api/skills/search` — both params were read raw before. */
export const searchSkillsQuerySchema = z.object({
	q: z.string().optional().default(""),
	owner: z.string().min(1).optional(),
});

export const setSkillEnabledBodySchema = z.object({
	repoId: z.string().min(1),
	enabled: z.boolean(),
});
export type SetSkillEnabledBody = z.infer<typeof setSkillEnabledBodySchema>;

// ---- Web push (ADR-0029) ---------------------------------------------------

/**
 * A push endpoint becomes a server-side `fetch` target, so a hostile one is
 * an SSRF vector rather than just a malformed row. Requiring HTTPS is the
 * cheap 90%: it rejects `file://`, and rules out plaintext
 * `http://localhost:6379`-style probes at internal services. Real push
 * endpoints (FCM, Mozilla, WNS) are always HTTPS, so this costs nothing.
 *
 * It does not stop an `https://` URL pointing at a private address; a full
 * fix would be an allowlist of known push origins, which would also break
 * self-hosted push services. Given a single-user app whose other routes
 * already run arbitrary agent code, this is the proportionate line.
 */
const httpsUrlSchema = z
	.string()
	.min(1)
	.refine(
		(value) => {
			try {
				return new URL(value).protocol === "https:";
			} catch {
				return false;
			}
		},
		{ message: "endpoint must be an https:// URL" },
	);

export const pushSubscribeBodySchema = z.object({
	endpoint: httpsUrlSchema,
	keys: z.object({
		p256dh: z.string().min(1),
		auth: z.string().min(1),
	}),
});
export type PushSubscribeBody = z.infer<typeof pushSubscribeBodySchema>;

export const pushUnsubscribeBodySchema = z.object({
	// Not `httpsUrlSchema`: unsubscribing is a delete by exact key, so a row
	// stored before the scheme check existed must still be removable.
	endpoint: z.string().min(1),
});
export type PushUnsubscribeBody = z.infer<typeof pushUnsubscribeBodySchema>;

// ---- Config ----------------------------------------------------------------

export const setProviderOverrideBodySchema = z.object({
	provider: z.string().min(1),
	model: z.string().min(1),
});
export type SetProviderOverrideBody = z.infer<
	typeof setProviderOverrideBodySchema
>;

export const setCredentialBodySchema = z.object({
	provider: z.string().min(1),
	apiKey: z.string().min(1),
});
export type SetCredentialBody = z.infer<typeof setCredentialBodySchema>;

export const completeOAuthBodySchema = z.object({
	loginId: z.string().min(1),
	input: z.string().min(1),
});
export type CompleteOAuthBody = z.infer<typeof completeOAuthBodySchema>;

export const cancelOAuthBodySchema = z.object({
	loginId: z.string().min(1),
});
export type CancelOAuthBody = z.infer<typeof cancelOAuthBodySchema>;

/**
 * The four API flavours a custom provider (Ollama, LM Studio, vLLM, ...) can
 * speak. The web client previously typed this as a bare `string` while the
 * server used a 4-literal union — the one place the hand-maintained
 * `LlmConfig`/`GetConfigResponse` twins had already drifted.
 */
export const customProviderApiSchema = z.enum([
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
]);
export type CustomProviderApi = z.infer<typeof customProviderApiSchema>;

export const customModelSchema = z.object({
	id: z.string().min(1),
	name: z.string().optional(),
});
export type CustomModelDef = z.infer<typeof customModelSchema>;

/** The editable fields of a custom provider — no `id` (path param on update,
 * separate key on create) and no stored key material on the way out. */
export const customProviderFieldsSchema = z.object({
	name: z.string().min(1),
	baseUrl: z.string().min(1),
	api: customProviderApiSchema,
	apiKey: z.string().optional(),
	/** Previously `Array.isArray(models)` with no element check, so
	 * `models: [null]` reached the store. */
	models: z.array(customModelSchema),
});
export type CustomProviderFields = z.infer<typeof customProviderFieldsSchema>;

export const createCustomProviderBodySchema = customProviderFieldsSchema.extend(
	{
		id: z.string().min(1),
	},
);
export type CreateCustomProviderBody = z.infer<
	typeof createCustomProviderBodySchema
>;

// ---- Config response envelope ----------------------------------------------

/** A single model option shown in the Settings dropdown. */
export type ProviderModelOption = { id: string; name: string };

/** A custom provider as sent to the client — never includes key material. */
export type CustomProviderView = {
	id: string;
	name: string;
	baseUrl: string;
	api: CustomProviderApi;
	models: CustomModelDef[];
};

/**
 * `GET /api/config`. Previously declared twice — `GetConfigResponse` on the
 * server and `LlmConfig` in the web client — kept in sync only by comment
 * cross-reference, and already drifted on `api`.
 */
export type LlmConfig = {
	/** The persisted provider/model override chosen in Settings (applies to
	 * new sessions), or null when dilna is falling back to the env vars. */
	override: { provider: string; model: string } | null;
	/** Raw DILNA_PROVIDER/DILNA_MODEL env values (may be empty when unset). */
	envDefault: { provider: string; model: string };
	/** The provider/model currently in effect: override if set, else env. */
	effective: { provider: string; model: string };
	/** Which providers have a usable key — stored (Settings) or env. */
	apiKeysConfigured: Record<string, boolean>;
	/** Providers with a **stored** key added via Settings, distinct from
	 * `apiKeysConfigured` which also counts env keys. Provider ids only; key
	 * material never leaves the server. */
	keyedStoredProviders: { provider: string }[];
	/** Provider -> selectable models for the dropdown. */
	modelsByProvider: Record<string, ProviderModelOption[]>;
	/** Providers with a connected OAuth login ("Sign in with Claude") — today
	 * only ever `{ anthropic: boolean }`. Outranks a stored API key. */
	oauthConnected: Record<string, boolean>;
	/** User-defined providers, already folded into `modelsByProvider`/
	 * `apiKeysConfigured`; this is for the management section only. */
	customProviders: CustomProviderView[];
};
