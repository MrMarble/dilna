import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { providerCredentials as providerCredentialsTable } from "../db/schema";
import { isDilnaProvider, PROVIDER_ALLOWLIST } from "./providerConfig";

/**
 * dilna-managed per-provider API keys (multi-provider support — see the
 * Settings view's "Add a provider" flow).
 *
 * Pre-multi-provider dilna authenticated every provider purely through host
 * env vars (`ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, ... — ADR-0005 host
 * passthrough), selected by a single global DILNA_PROVIDER/DILNA_MODEL pair.
 * That made it impossible to configure several providers *at once*: you could
 * only ever enable whichever provider you pointed the one selector at, and
 * the Settings view's provider/model picker had no way to provision a key.
 *
 * This module lifts that. Keys you save in Settings are stored here (in the
 * `provider_credentials` table) and layered *over* the env default for the
 * same provider:
 *
 *   resolved key = stored key (Settings) ?? matching *_API_KEY env var
 *
 * Env stays the fallback so existing env-only deployments keep working
 * byte-for-byte (matching how the provider/model override already layers over
 * DILNA_PROVIDER/DILNA_MODEL); a stored key wins once the operator adds it,
 * even if a stale env key lingers or only some providers are set in env.
 * Every agent-start API-key resolution in `pi.ts` consults this module on the
 * hot path (stored keys are cached in a module global at boot and kept in
 * sync on write, so that never costs a DB hit) instead of reading env alone.
 *
 * Storage-at-rest note: keys are written to the same single-user SQLite db
 * dilna already keeps every other secret/config in (llm_config overrides,
 * repo memory) as *plaintext*, consistent with dilna having no auth/boundary
 * to encrypt against (see the schema comment). The Settings UI only ever
 * displays a masked sentinel and re-sends the actual key to set/replace.
 */

export type StoredProviderKey = { provider: string };

/** In-memory mirror of the credential rows, so agent-start key lookups never
 * hit SQLite on the hot path. Primed once at boot by
 * {@link primeProviderCredentials} and kept in sync by every write below. */
let storedKeys = new Map<string, string>();

function readStoredKeysFromDb(): Map<string, string> {
	const db = getDb();
	const rows = db.select().from(providerCredentialsTable).all();
	const map = new Map<string, string>();
	for (const row of rows) map.set(row.provider, row.apiKey);
	return map;
}

/** Load credential rows into the module cache. Called once at boot (index.ts),
 * same as {@link providerConfigStore.primeOverrideFromDb}. */
export function primeProviderCredentials(): void {
	storedKeys = readStoredKeysFromDb();
}

/** The stored provider ids (dilna-managed keys), for listing which providers
 * are configured in Settings — deliberately without key material, which the
 * web UI must never receive back. */
export function listStoredProviderKeys(): StoredProviderKey[] {
	return [...storedKeys.keys()].map((provider) => ({ provider }));
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
	if (!isDilnaProvider(p)) {
		return {
			ok: false,
			error: `${p || "(empty)"} is not a supported provider. Valid values: ${PROVIDER_ALLOWLIST.join(", ")}`,
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
	storedKeys.set(p, k);
	return { ok: true };
}

/** Forget a provider's stored key, falling back to env for that provider. */
export function clearProviderApiKey(provider: string): void {
	const db = getDb();
	db.delete(providerCredentialsTable)
		.where(eq(providerCredentialsTable.provider, provider))
		.run();
	storedKeys.delete(provider);
}

/**
 * The effective API key for a provider: the stored (Settings) key if one is
 * set, else the provider's own env var (`getEnvApiKey` — the ADR-0005 host
 * passthrough default). This is the single resolution point the agent-start
 * path in `pi.ts` and the Settings enabled-check both use.
 */
export function resolveApiKey(provider: string): string | undefined {
	const stored = storedKeys.get(provider);
	if (stored) return stored;
	return getEnvApiKey(provider, process.env as Record<string, string>);
}

/** Whether the provider currently has *any* usable key (stored or env). */
export function hasApiKey(provider: string): boolean {
	if (!isDilnaProvider(provider)) return false;
	return Boolean(resolveApiKey(provider));
}
