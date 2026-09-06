import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
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
	type StoredProviderKey,
	setProviderApiKey,
} from "../agents/providerCredentials";
import {
	cancelAnthropicLogin,
	completeAnthropicLogin,
	startAnthropicLogin,
} from "../agents/providerOAuth";

type ProviderModelOption = { id: string; name: string };

type GetConfigResponse = {
	/** The persisted provider/model override chosen in Settings (applies to
	 * new sessions), or null when dilna is falling back to the env vars. */
	override: { provider: string; model: string } | null;
	/** Raw DILNA_PROVIDER/DILNA_MODEL env values (may be empty strings/null
	 * when unset). */
	envDefault: { provider: string; model: string };
	/** The provider/model currently in effect: override if set, else env. */
	effective: { provider: string; model: string };
	/** Which of the allowlisted providers has a usable API key — a key added
	 * in Settings (`keyedStoredProviders`'s members) or an env key (`*_API_KEY`
	 * host passthrough). Lets the form steer the user and explain why a
	 * choice is unusable. */
	apiKeysConfigured: Record<string, boolean>;
	/** Provider -> selectable models for the dropdown. */
	modelsByProvider: Record<string, ProviderModelOption[]>;
	/** Providers that have a **stored** key added via Settings (multi-provider
	 * support) — distinct from `apiKeysConfigured`, which also counts env
	 * keys. Drives the "Added providers" list in the Settings view. */
	keyedStoredProviders: StoredProviderKey[];
	/** Providers with a connected OAuth login ("Sign in with Claude") — today
	 * only ever `{ anthropic: boolean }`, since it's the only allowlisted
	 * provider `pi-ai` ships an OAuth flow for. Drives the Settings view's
	 * "Connected" indicator; an OAuth login outranks a stored API key for the
	 * same provider (see providerCredentials.ts). */
	oauthConnected: Record<string, boolean>;
};

export const configRoute = new Hono();

function modelsFor(provider: DilnaProvider): ProviderModelOption[] {
	return getBuiltinModels(provider).map((m) => ({ id: m.id, name: m.name }));
}

configRoute.get("/", async (c) => {
	const override = getOverride();
	const envProvider = process.env.DILNA_PROVIDER ?? "";
	const envModel = process.env.DILNA_MODEL ?? "";
	const modelsByProvider: Record<string, ProviderModelOption[]> = {};
	for (const provider of PROVIDER_ALLOWLIST) {
		modelsByProvider[provider] = modelsFor(provider);
	}
	const apiKeysConfigured: Record<string, boolean> = {};
	await Promise.all(
		PROVIDER_ALLOWLIST.map(async (provider) => {
			apiKeysConfigured[provider] = await providerApiKeyConfigured(provider);
		}),
	);
	const body: GetConfigResponse = {
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
	};
	return c.json(body);
});

type SetConfigBody = { provider: string; model: string };

configRoute.put("/", async (c) => {
	const body = (await c.req.json().catch(() => null)) as SetConfigBody | null;
	if (
		!body ||
		typeof body.provider !== "string" ||
		typeof body.model !== "string"
	) {
		throw new HTTPException(400, {
			message: "Expected { provider, model } to set a provider/model override.",
		});
	}
	const result = await setOverride(body.provider, body.model);
	if (!result.ok) {
		throw new HTTPException(400, { message: result.error });
	}
	return c.json({ ok: true, override: getOverride() });
});

configRoute.delete("/", (c) => {
	clearOverride();
	return c.json({ ok: true, override: null });
});

// ---- Stored API keys (multi-provider — see providerCredentials.ts) ----------

type SetCredentialBody = { provider: string; apiKey: string };

/** Save (replace) a provider's API key so Settings can provision providers
 * that aren't (or aren't only) configured via env. */
configRoute.put("/credentials", async (c) => {
	const body = (await c.req
		.json()
		.catch(() => null)) as SetCredentialBody | null;
	if (
		!body ||
		typeof body.provider !== "string" ||
		typeof body.apiKey !== "string"
	) {
		throw new HTTPException(400, {
			message: "Expected { provider, apiKey } to save a provider key.",
		});
	}
	const result = setProviderApiKey(body.provider, body.apiKey);
	if (!result.ok) {
		throw new HTTPException(400, { message: result.error });
	}
	return c.json({ ok: true });
});

/** Forget a provider's stored key (falls back to its env key thereafter). */
configRoute.delete("/credentials/:provider", (c) => {
	clearProviderApiKey(c.req.param("provider"));
	return c.json({ ok: true });
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
	return c.json({ loginId: result.loginId, authUrl: result.authUrl });
});

type CompleteOAuthBody = { loginId: string; input: string };

/** Finish a pending login with the code/redirect URL the user pasted back. */
configRoute.post("/providers/anthropic/oauth/complete", async (c) => {
	const body = (await c.req
		.json()
		.catch(() => null)) as CompleteOAuthBody | null;
	if (
		!body ||
		typeof body.loginId !== "string" ||
		typeof body.input !== "string"
	) {
		throw new HTTPException(400, {
			message: "Expected { loginId, input } to complete a login.",
		});
	}
	const result = await completeAnthropicLogin(body.loginId, body.input);
	if (!result.ok) {
		throw new HTTPException(400, { message: result.error });
	}
	return c.json({ ok: true });
});

type CancelOAuthBody = { loginId: string };

/** Abandon a pending login (e.g. the user closed the dialog). */
configRoute.post("/providers/anthropic/oauth/cancel", async (c) => {
	const body = (await c.req.json().catch(() => null)) as CancelOAuthBody | null;
	if (!body || typeof body.loginId !== "string") {
		throw new HTTPException(400, {
			message: "Expected { loginId } to cancel a login.",
		});
	}
	cancelAnthropicLogin(body.loginId);
	return c.json({ ok: true });
});

/** Disconnect Anthropic's OAuth login (falls back to a stored API key or env
 * thereafter). */
configRoute.delete("/providers/anthropic/oauth", (c) => {
	clearProviderOAuthCredential("anthropic");
	return c.json({ ok: true });
});
