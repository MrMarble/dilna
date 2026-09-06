import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { providerCredentials as providerCredentialsTable } from "../db/schema";
import { isCustomProvider } from "./customProviders";
import { isDilnaProvider, PROVIDER_ALLOWLIST } from "./providerConfig";

/**
 * dilna-managed per-provider credentials (multi-provider support — see the
 * Settings view's "Add a provider" / "Sign in with Claude" flows).
 *
 * Pre-multi-provider dilna authenticated every provider purely through host
 * env vars (`ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, ... — ADR-0005 host
 * passthrough), selected by a single global DILNA_PROVIDER/DILNA_MODEL pair.
 * That made it impossible to configure several providers *at once*: you could
 * only ever enable whichever provider you pointed the one selector at, and
 * the Settings view's provider/model picker had no way to provision a key.
 *
 * This module lifts that. Credentials you save in Settings are stored here
 * (in the `provider_credentials` table) and layered *over* the env default
 * for the same provider:
 *
 *   resolved key = stored OAuth token (refreshed if needed)
 *               ?? stored API key (Settings)
 *               ?? matching *_API_KEY env var
 *
 * Env stays the fallback so existing env-only deployments keep working
 * byte-for-byte; a stored key wins once the operator adds it, even if a
 * stale env key lingers or only some providers are set in env. OAuth outranks
 * a stored API key for the same provider when both exist — it's the more
 * deliberate, more recently taken action (same precedent as stored-over-env).
 * Every agent-start API-key resolution in `pi.ts` consults this module on the
 * hot path (stored keys are cached in a module global at boot and kept in
 * sync on write, so a plain API-key read never costs a DB hit; an OAuth read
 * costs a DB hit only when a refresh actually happens) instead of reading env
 * alone.
 *
 * OAuth support (Anthropic only — the only dilna-allowlisted provider `pi-ai`
 * ships an OAuth flow for) needs no special-casing on the request path: a
 * live OAuth access token is a `sk-ant-oat...`-prefixed string, and `pi-ai`'s
 * anthropic-messages API layer already auto-detects that prefix and switches
 * to Bearer auth + the right `anthropic-beta` headers itself. So
 * `resolveApiKey` just needs to hand back the right *string* — the interactive
 * login flow itself lives in `providerOAuth.ts`, which calls
 * {@link setProviderOAuthCredential} once a login completes.
 *
 * Storage-at-rest note: credentials are written to the same single-user
 * SQLite db dilna already keeps every other secret/config in (llm_config
 * overrides, repo memory) as *plaintext*, consistent with dilna having no
 * auth/boundary to encrypt against (see the schema comment). The Settings UI
 * only ever displays a masked sentinel / connected indicator, never key or
 * token material.
 */

export type StoredProviderKey = { provider: string };

type StoredOAuth = { access: string; refresh: string; expiresAt: number };
type StoredCredential = { apiKey: string | null; oauth: StoredOAuth | null };

/** In-memory mirror of the credential rows, so agent-start key lookups never
 * hit SQLite on the hot path. Primed once at boot by
 * {@link primeProviderCredentials} and kept in sync by every write below. */
let storedCredentials = new Map<string, StoredCredential>();

function readStoredCredentialsFromDb(): Map<string, StoredCredential> {
	const db = getDb();
	const rows = db.select().from(providerCredentialsTable).all();
	const map = new Map<string, StoredCredential>();
	for (const row of rows) {
		map.set(row.provider, {
			apiKey: row.apiKey,
			oauth:
				row.oauthAccess && row.oauthRefresh && row.oauthExpiresAt
					? {
							access: row.oauthAccess,
							refresh: row.oauthRefresh,
							expiresAt: row.oauthExpiresAt,
						}
					: null,
		});
	}
	return map;
}

/** Load credential rows into the module cache. Called once at boot (index.ts),
 * same as {@link providerConfigStore.primeOverrideFromDb}. */
export function primeProviderCredentials(): void {
	storedCredentials = readStoredCredentialsFromDb();
}

/** The stored provider ids (dilna-managed keys — API key or OAuth), for
 * listing which providers are configured in Settings — deliberately without
 * key material, which the web UI must never receive back. */
export function listStoredProviderKeys(): StoredProviderKey[] {
	return [...storedCredentials.keys()].map((provider) => ({ provider }));
}

/** Whether a provider has a stored OAuth login (Settings "Connected"
 * indicator) — without exposing token material. */
export function hasOAuthCredential(provider: string): boolean {
	return Boolean(storedCredentials.get(provider)?.oauth);
}

/**
 * Save (upsert) an API key for a provider, replacing any previously stored
 * one. Validates the provider is one dilna supports up front, mirroring
 * `providerConfigStore.setOverride` — no point storing a provider we could
 * never run. The value is trimmed; an empty value deletes instead (the UI
 * sends a delete for that, but this keeps the store self-consistent).
 */
export function setProviderApiKey(
	provider: string,
	apiKey: string,
): { ok: true } | { ok: false; error: string } {
	const p = provider.trim();
	const k = apiKey.trim();
	if (!isDilnaProvider(p) && !isCustomProvider(p)) {
		return {
			ok: false,
			error: `${p || "(empty)"} is not a supported provider. Valid values: ${PROVIDER_ALLOWLIST.join(", ")}, or a configured custom provider.`,
		};
	}
	if (!k) {
		return { ok: false, error: "API key can't be empty." };
	}

	const db = getDb();
	db.insert(providerCredentialsTable)
		.values({
			provider: p,
			apiKey: k,
			updatedAt: Math.floor(Date.now() / 1000),
		})
		.onConflictDoUpdate({
			target: providerCredentialsTable.provider,
			set: {
				apiKey: k,
				updatedAt: Math.floor(Date.now() / 1000),
			},
		})
		.run();
	const existing = storedCredentials.get(p);
	storedCredentials.set(p, { apiKey: k, oauth: existing?.oauth ?? null });
	return { ok: true };
}

/** Forget a provider's stored key, falling back to OAuth (if connected) or
 * env for that provider. */
export function clearProviderApiKey(provider: string): void {
	const db = getDb();
	db.update(providerCredentialsTable)
		.set({ apiKey: null, updatedAt: Math.floor(Date.now() / 1000) })
		.where(eq(providerCredentialsTable.provider, provider))
		.run();
	const existing = storedCredentials.get(provider);
	if (existing?.oauth) {
		storedCredentials.set(provider, { apiKey: null, oauth: existing.oauth });
	} else {
		storedCredentials.delete(provider);
	}
}

/**
 * Save (upsert) an OAuth login for a provider, called by `providerOAuth.ts`
 * once a login/refresh completes. Leaves any stored API key for the same
 * provider untouched — OAuth just outranks it (see this module's doc
 * comment).
 */
export function setProviderOAuthCredential(
	provider: string,
	credential: OAuthCredential,
): void {
	const db = getDb();
	db.insert(providerCredentialsTable)
		.values({
			provider,
			oauthAccess: credential.access,
			oauthRefresh: credential.refresh,
			oauthExpiresAt: credential.expires,
			updatedAt: Math.floor(Date.now() / 1000),
		})
		.onConflictDoUpdate({
			target: providerCredentialsTable.provider,
			set: {
				oauthAccess: credential.access,
				oauthRefresh: credential.refresh,
				oauthExpiresAt: credential.expires,
				updatedAt: Math.floor(Date.now() / 1000),
			},
		})
		.run();
	const existing = storedCredentials.get(provider);
	storedCredentials.set(provider, {
		apiKey: existing?.apiKey ?? null,
		oauth: {
			access: credential.access,
			refresh: credential.refresh,
			expiresAt: credential.expires,
		},
	});
}

/** Disconnect a provider's OAuth login, falling back to its stored API key
 * (if any) or env thereafter. */
export function clearProviderOAuthCredential(provider: string): void {
	const db = getDb();
	db.update(providerCredentialsTable)
		.set({
			oauthAccess: null,
			oauthRefresh: null,
			oauthExpiresAt: null,
			updatedAt: Math.floor(Date.now() / 1000),
		})
		.where(eq(providerCredentialsTable.provider, provider))
		.run();
	const existing = storedCredentials.get(provider);
	if (existing?.apiKey) {
		storedCredentials.set(provider, { apiKey: existing.apiKey, oauth: null });
	} else {
		storedCredentials.delete(provider);
	}
}

/** Require this much remaining OAuth-token validity before using it without
 * refreshing first — mirrors `pi-ai`'s own `AuthResolutionOverrides` default
 * (`auth/resolve.d.ts`). */
const OAUTH_MIN_VALIDITY_MS = 5 * 60 * 1000;

let cachedAnthropicOAuth: OAuthAuth | null = null;
/** `anthropicProvider().auth.oauth` is a `lazyOAuth` wrapper (dynamic import
 * on first use) — cache the resolved object rather than re-triggering that
 * import on every turn. Only ever needed for `provider === "anthropic"`,
 * dilna's one OAuth-capable allowlisted provider. */
async function getAnthropicOAuth(): Promise<OAuthAuth> {
	if (!cachedAnthropicOAuth) {
		const oauth = anthropicProvider().auth.oauth;
		if (!oauth) {
			throw new Error("pi-ai's anthropic provider has no OAuth auth defined");
		}
		cachedAnthropicOAuth = oauth;
	}
	return cachedAnthropicOAuth;
}

/**
 * Resolve a stored OAuth credential to a live access token, refreshing first
 * if it's within {@link OAUTH_MIN_VALIDITY_MS} of expiry. Refresh failures are
 * logged and degrade to the *stored* (possibly stale) access token rather
 * than throwing — same soft-fail posture as ADR-0015's usage pull: a turn
 * should never crash because a background refresh failed, and the provider
 * itself will reject a genuinely expired token with a clear auth error.
 */
async function resolveOAuthAccessToken(
	provider: string,
	oauth: StoredOAuth,
): Promise<string> {
	if (oauth.expiresAt - Date.now() > OAUTH_MIN_VALIDITY_MS) {
		return oauth.access;
	}
	try {
		const auth = await getAnthropicOAuth();
		const refreshed = await auth.refresh(
			{
				type: "oauth",
				access: oauth.access,
				refresh: oauth.refresh,
				expires: oauth.expiresAt,
			},
			AbortSignal.timeout(30_000),
		);
		setProviderOAuthCredential(provider, refreshed);
		return refreshed.access;
	} catch (err) {
		console.error(
			`[providerCredentials] OAuth refresh failed for ${provider}:`,
			err,
		);
		return oauth.access;
	}
}

/**
 * The effective API key for a provider: a stored OAuth token (refreshed if
 * needed) if one is connected, else the stored (Settings) API key if one is
 * set, else the provider's own env var (`getEnvApiKey` — the ADR-0005 host
 * passthrough default). This is the single resolution point the agent-start
 * path in `pi.ts` and the Settings enabled-check both use.
 */
export async function resolveApiKey(
	provider: string,
): Promise<string | undefined> {
	const stored = storedCredentials.get(provider);
	if (stored?.oauth) {
		return resolveOAuthAccessToken(provider, stored.oauth);
	}
	if (stored?.apiKey) return stored.apiKey;
	return getEnvApiKey(provider, process.env as Record<string, string>);
}

/** Whether the provider currently has *any* usable key (stored, OAuth, or
 * env). */
export async function hasApiKey(provider: string): Promise<boolean> {
	if (!isDilnaProvider(provider) && !isCustomProvider(provider)) return false;
	return Boolean(await resolveApiKey(provider));
}
