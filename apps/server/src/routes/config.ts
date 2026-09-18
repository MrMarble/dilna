import {
	type ClearOverrideResponse,
	cancelOAuthBodySchema,
	completeOAuthBodySchema,
	createCustomProviderBodySchema,
	customProviderFieldsSchema,
	type LlmConfig,
	type OauthStartResponse,
	type OkResponse,
	type ProviderModelOption,
	type SetOverrideResponse,
	setCredentialBodySchema,
	setProviderOverrideBodySchema,
} from "@dilna/shared";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
	deleteCustomProvider,
	listCustomProviders,
	setCustomProvider,
} from "../agents/customProviders";
import {
	type DilnaProvider,
	PROVIDER_ALLOWLIST,
} from "../agents/providerConfig";
import {
	clearOverride,
	effectiveModel,
	effectiveProvider,
	getOverride,
	providerApiKeyConfigured,
	setOverride,
} from "../agents/providerConfigStore";
import {
	clearProviderApiKey,
	clearProviderOAuthCredential,
	hasOAuthCredential,
	listStoredProviderKeys,
	setProviderApiKey,
} from "../agents/providerCredentials";
import {
	cancelAnthropicLogin,
	completeAnthropicLogin,
	startAnthropicLogin,
} from "../agents/providerOAuth";
import { validate } from "./factory";

// The `GET /` response type (`LlmConfig`) and every request body schema below
// now live in `@dilna/shared`, so the web client types against the same
// declaration instead of a hand-maintained twin. See apiSchemas.ts.

export const configRoute = new Hono();

function modelsFor(provider: DilnaProvider): ProviderModelOption[] {
	return getBuiltinModels(provider).map((m) => ({ id: m.id, name: m.name }));
}

configRoute.get("/", async (c) => {
	const override = getOverride();
	const envProvider = process.env.DILNA_PROVIDER ?? "";
	const envModel = process.env.DILNA_MODEL ?? "";
	const customProviders = listCustomProviders();

	const modelsByProvider: Record<string, ProviderModelOption[]> = {};
	for (const provider of PROVIDER_ALLOWLIST) {
		modelsByProvider[provider] = modelsFor(provider);
	}
	for (const custom of customProviders) {
		modelsByProvider[custom.id] = custom.models.map((m) => ({
			id: m.id,
			name: m.name || m.id,
		}));
	}

	const apiKeysConfigured: Record<string, boolean> = {};
	await Promise.all(
		[...PROVIDER_ALLOWLIST, ...customProviders.map((p) => p.id)].map(
			async (provider) => {
				apiKeysConfigured[provider] = await providerApiKeyConfigured(provider);
			},
		),
	);
	const body: LlmConfig = {
		override,
		envDefault: { provider: envProvider, model: envModel },
		// effectiveProvider()/effectiveModel() already fall back to env.
		effective: {
			provider: effectiveProvider(),
			model: effectiveModel(),
		},
		apiKeysConfigured,
		modelsByProvider,
		keyedStoredProviders: listStoredProviderKeys(),
		oauthConnected: { anthropic: hasOAuthCredential("anthropic") },
		customProviders,
	};
	return c.json(body);
});

configRoute.put(
	"/",
	validate("json", setProviderOverrideBodySchema),
	async (c) => {
		const body = c.req.valid("json");
		const result = await setOverride(body.provider, body.model);
		if (!result.ok) {
			throw new HTTPException(400, { message: result.error });
		}
		const res: SetOverrideResponse = { ok: true, override: getOverride() };
		return c.json(res);
	},
);

configRoute.delete("/", (c) => {
	clearOverride();
	const res: ClearOverrideResponse = { ok: true, override: null };
	return c.json(res);
});

// ---- Stored API keys (multi-provider — see providerCredentials.ts) ----------

/** Save (replace) a provider's API key so Settings can provision providers
 * that aren't (or aren't only) configured via env. */
configRoute.put(
	"/credentials",
	validate("json", setCredentialBodySchema),
	(c) => {
		const body = c.req.valid("json");
		const result = setProviderApiKey(body.provider, body.apiKey);
		if (!result.ok) {
			throw new HTTPException(400, { message: result.error });
		}
		return c.json<OkResponse>({ ok: true });
	},
);

/** Forget a provider's stored key (falls back to its env key thereafter). */
configRoute.delete("/credentials/:provider", (c) => {
	clearProviderApiKey(c.req.param("provider"));
	return c.json<OkResponse>({ ok: true });
});

// ---- Anthropic OAuth ("Sign in with Claude" — see providerOAuth.ts) --------

/** Begin an Anthropic OAuth login: returns a URL to open plus a `loginId` to
 * complete it with once the user pastes back the resulting code/redirect
 * URL. */
configRoute.post("/providers/anthropic/oauth/start", async (c) => {
	const result = await startAnthropicLogin();
	if (!result.ok) {
		throw new HTTPException(502, { message: result.error });
	}
	const res: OauthStartResponse = {
		loginId: result.loginId,
		authUrl: result.authUrl,
	};
	return c.json(res);
});

/** Finish a pending login with the code/redirect URL the user pasted back. */
configRoute.post(
	"/providers/anthropic/oauth/complete",
	validate("json", completeOAuthBodySchema),
	async (c) => {
		const body = c.req.valid("json");
		const result = await completeAnthropicLogin(body.loginId, body.input);
		if (!result.ok) {
			throw new HTTPException(400, { message: result.error });
		}
		return c.json<OkResponse>({ ok: true });
	},
);

/** Abandon a pending login (e.g. the user closed the dialog). */
configRoute.post(
	"/providers/anthropic/oauth/cancel",
	validate("json", cancelOAuthBodySchema),
	(c) => {
		cancelAnthropicLogin(c.req.valid("json").loginId);
		return c.json<OkResponse>({ ok: true });
	},
);

/** Disconnect Anthropic's OAuth login (falls back to a stored API key or env
 * thereafter). */
configRoute.delete("/providers/anthropic/oauth", (c) => {
	clearProviderOAuthCredential("anthropic");
	return c.json<OkResponse>({ ok: true });
});

// ---- Custom providers (Ollama, LM Studio, vLLM, ... — see customProviders.ts) ----

/** Create a custom provider (id in the body, since there's no path segment
 * for it yet), plus its API key when one is given — a single "Add custom
 * provider" dialog submission, two internal writes, mirroring how OAuth's
 * "complete" route also writes to two places. */
configRoute.post(
	"/custom-providers",
	validate("json", createCustomProviderBodySchema),
	(c) => {
		const { id, ...fields } = c.req.valid("json");
		const result = setCustomProvider({ id, ...fields });
		if (!result.ok) {
			throw new HTTPException(400, { message: result.error });
		}
		if (fields.apiKey?.trim()) {
			const keyResult = setProviderApiKey(id, fields.apiKey);
			if (!keyResult.ok) {
				throw new HTTPException(400, { message: keyResult.error });
			}
		}
		return c.json<OkResponse>({ ok: true });
	},
);

/** Update a custom provider's definition; the id is immutable (path param —
 * the body only carries the editable fields). Replaces the stored key only
 * when a non-empty `apiKey` is sent — an edit shouldn't force re-entering a
 * key that's already fine. */
configRoute.put(
	"/custom-providers/:id",
	validate("json", customProviderFieldsSchema),
	(c) => {
		const id = c.req.param("id");
		const body = c.req.valid("json");
		const result = setCustomProvider({ id, ...body });
		if (!result.ok) {
			throw new HTTPException(400, { message: result.error });
		}
		if (body.apiKey?.trim()) {
			const keyResult = setProviderApiKey(id, body.apiKey);
			if (!keyResult.ok) {
				throw new HTTPException(400, { message: keyResult.error });
			}
		}
		return c.json<OkResponse>({ ok: true });
	},
);

/** Delete a custom provider and its stored key. Doesn't clear an active
 * override still pointing at it (see customProviders.ts's doc comment on
 * `deleteCustomProvider`). */
configRoute.delete("/custom-providers/:id", (c) => {
	deleteCustomProvider(c.req.param("id"), clearProviderApiKey);
	return c.json<OkResponse>({ ok: true });
});
