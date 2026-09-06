import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { llmConfig as llmConfigTable } from "../db/schema";
import {
	customProviderModelIds,
	getCustomProvider,
	isCustomProvider,
} from "./customProviders";
import {
	catalogModelIds,
	type DilnaProvider,
	isDilnaProvider,
	PROVIDER_ALLOWLIST,
} from "./providerConfig";
import { hasApiKey, resolveApiKey } from "./providerCredentials";

/**
 * Instance-wide LLM provider/model override + the single resolution point
 * every code path that picks a provider/model goes through (pi.ts's agent
 * construction, usage-event recording, boot config checks).
 *
 * Background (ADR-0020, .env.example): dilna historically selected its one
 * global provider/model purely via `DILNA_PROVIDER`/`DILNA_MODEL` env vars.
 * This module keeps that env value as the **default/fallback** and layers a
 * persisted, web-settable override *in front of it*:
 *
 *   effective = override (from the `llm_config` row) ?? DILNA_PROVIDER/MODEL
 *
 * When no override is set this returns exactly the env values, so existing
 * env-only deployments behave byte-for-byte as before. When the Settings UI
 * writes an override (see the `/api/config` route and the web Settings view),
 * it wins from then on — *including across restarts*, since it's persisted in
 * SQLite rather than re-derived from a process env the operator may have
 * cleared. Environment remains a fallback only: clearing the override returns
 * control to the env vars.
 *
 * `DILNA_PROVIDER`/`DILNA_MODEL` are read live from `process.env` (not
 * captured at import time), matching how the rest of the server reads them —
 * a unit test that sets them mid-module still works. The override layer is
 * cached in a module global, primed from the DB at boot by
 * {@link primeOverrideFromDb} and kept in sync on every write, so agent-start
 * reads on the hot path never pay a DB hit.
 */

const CONFIG_ROW_ID = "instance";

/** `provider` is a builtin allowlisted id or a custom provider id
 * (customProviders.ts) — not narrowed to `DilnaProvider` since either can be
 * stored here. */
type Override = { provider: string; model: string } | null;

/**
 * In-memory mirror of the persisted override row. Starts as `null` ("no
 * override") and is populated from the DB once at boot by
 * {@link primeOverrideFromDb}, then kept in sync on every write. Read-only
 * helpers ({@link effectiveProvider}/{@link effectiveModel}, used from a
 * couple of pure conversion paths) read this cache rather than the DB so they
 * never hit SQLite on the hot path — correctness relies on `index.ts`
 * priming at boot (which it does).
 */
let overrideCache: Override = null;

function readOverrideFromDb(): Override {
	const db = getDb();
	const row = db
		.select()
		.from(llmConfigTable)
		.where(eq(llmConfigTable.id, CONFIG_ROW_ID))
		.get();
	if (!row) return null;
	if (
		!row.provider ||
		!row.model ||
		(!isDilnaProvider(row.provider) && !isCustomProvider(row.provider))
	) {
		// A legacy/partial/never-valid row counts as "no override" rather than
		// poisoning the effective value — the Settings write path never stores
		// one (validation happens before persist), so this is defensive only.
		return null;
	}
	return { provider: row.provider, model: row.model };
}

/**
 * Load the persisted override row into the module cache. Called once at boot
 * (index.ts) so the first agent-start read doesn't need to hit the DB. Callers
 * that mutate the override update the cache themselves, so this only needs to
 * run again after a direct DB change.
 */
export function primeOverrideFromDb(): void {
	overrideCache = readOverrideFromDb();
}

/** The currently-active persisted override (null when falling back to env). */
export function getOverride(): Override {
	return overrideCache;
}

function setCache(override: Override): void {
	overrideCache = override;
}

export type SetOverrideResult = { ok: true } | { ok: false; error: string };

/** Model ids selectable for `provider` — the builtin catalog for an
 * allowlisted provider, or a stored custom provider's own model list
 * (customProviders.ts). Empty for an unknown provider id. */
function modelIdsForProvider(provider: string): string[] {
	if (isDilnaProvider(provider)) return catalogModelIds(provider);
	const custom = getCustomProvider(provider);
	return custom ? customProviderModelIds(custom.id) : [];
}

/**
 * Validate and persist a new override, replacing the row if one exists. Empty
 * string values are treated as "clear the field". Any invalid combination
 * (provider outside the allowlist, a model not in that provider's catalog, or
 * no matching API key configured — in env or in Settings) is rejected up
 * front so the DB never holds a combination the agent startup path couldn't
 * resolve — the pi.ts "should not happen" guards stay genuinely unreachable.
 */
export async function setOverride(
	provider: string,
	model: string,
): Promise<SetOverrideResult> {
	const p = provider.trim();
	const m = model.trim();
	if (!p && !m) {
		return {
			ok: false,
			error: "Nothing to set — provider and model are both empty.",
		};
	}
	if (!isDilnaProvider(p) && !isCustomProvider(p)) {
		return {
			ok: false,
			error: `${p || "(empty)"} is not a supported provider. Valid values: ${PROVIDER_ALLOWLIST.join(", ")}, or a configured custom provider.`,
		};
	}
	if (!m) {
		return { ok: false, error: "Choose a model for the selected provider." };
	}
	const catalog = modelIdsForProvider(p);
	if (!catalog.includes(m)) {
		return {
			ok: false,
			error: `${m} is not a known model for provider "${p}".`,
		};
	}
	const apiKey = await resolveApiKey(p);
	if (!apiKey) {
		return {
			ok: false,
			error: `No API key configured for provider "${p}" — set its matching env var (e.g. ANTHROPIC_API_KEY for "anthropic") or add the provider's key in Settings.`,
		};
	}

	const override: Override = { provider: p, model: m };
	const db = getDb();
	db.insert(llmConfigTable)
		.values({
			id: CONFIG_ROW_ID,
			...override,
			updatedAt: Math.floor(Date.now() / 1000),
		})
		.onConflictDoUpdate({
			target: llmConfigTable.id,
			set: {
				...override,
				updatedAt: Math.floor(Date.now() / 1000),
			},
		})
		.run();
	setCache(override);
	return { ok: true };
}

/** Drop the override so provider/model fall back to the env vars again. */
export function clearOverride(): void {
	const db = getDb();
	db.delete(llmConfigTable).where(eq(llmConfigTable.id, CONFIG_ROW_ID)).run();
	setCache(null);
}

/** Provider for a fresh session — the persisted override if set, else env. */
export function effectiveProvider(): string {
	return getOverride()?.provider ?? process.env.DILNA_PROVIDER ?? "";
}

/** Model id for a fresh session — the persisted override if set, else env. */
export function effectiveModel(): string {
	return getOverride()?.model ?? process.env.DILNA_MODEL ?? "";
}

/**
 * Whether the given provider currently has an API key configured in env —
 * used by the Settings UI to steer the user toward a keyed provider and to
 * reject an override whose key isn't present (see {@link setOverride}).
 */
export function providerApiKeyConfigured(provider: string): Promise<boolean> {
	return hasApiKey(provider);
}

/** Build the effective `Model` object pi expects, or `null` if unresolved. */
export function effectivePiModel(): {
	provider: DilnaProvider;
	modelId: string;
	model: ReturnType<typeof getBuiltinModels<DilnaProvider>>[number] | undefined;
} | null {
	const provider = effectiveProvider();
	if (!isDilnaProvider(provider)) return null;
	const modelId = effectiveModel();
	if (!modelId) return null;
	return {
		provider,
		modelId,
		model: getBuiltinModels(provider).find((m) => m.id === modelId),
	};
}
