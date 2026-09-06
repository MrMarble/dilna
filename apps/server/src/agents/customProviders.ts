import type { Model } from "@earendil-works/pi-ai";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { customProviders as customProvidersTable } from "../db/schema";
import {
	CUSTOM_PROVIDER_APIS,
	type CustomProviderApi,
	isCustomProviderApi,
	isDilnaProvider,
	PROVIDER_ALLOWLIST,
} from "./providerConfig";

/**
 * User-defined LLM providers (Ollama, LM Studio, vLLM, or anything else
 * speaking one of `CUSTOM_PROVIDER_APIS`) — the Settings view's "Add a custom
 * provider" flow, dilna's answer to pi's own CLI-only `~/.pi/agent/models.json`
 * (https://pi.dev/docs/latest/models).
 *
 * `pi-coding-agent` (the CLI) has its own `models.json` loader
 * (`ModelConfig.load`, typebox-validated), but it lives in that package's
 * internals and isn't part of its public `exports` map — there is nothing to
 * import here. This module is dilna's own, much smaller equivalent: no
 * `$ENV`/`!command` API-key resolution (Settings already takes a literal key,
 * same as builtin providers), no custom headers, no OAuth, no per-model
 * overrides beyond an optional display name — just enough to point at an
 * OpenAI/Anthropic/Google-compatible endpoint.
 *
 * The key realization that keeps this module small: dilna never used `pi-ai`'s
 * `Provider`/auth-registry abstraction (`createProvider`, `resolveProviderAuth`)
 * in the first place — `pi.ts` builds a `Model<Api>` object directly and hands
 * it, plus a plain `apiKey` string, straight to `pi-ai/compat`'s
 * `streamSimple`/`completeSimple`. Reading those API implementations
 * (`openai-completions.js`, `openai-responses.js`, `google-generative-ai.js`)
 * confirms each uses `model.baseUrl`/`options.apiKey` directly, with
 * `model.provider` only feeding cosmetic per-provider heuristics — harmless
 * no-ops for an arbitrary custom id. So a custom provider is nothing more than
 * a `Model<Api>` {@link buildCustomModel} constructs from the config stored
 * here, filling every field `models.json` would default (contextWindow
 * 128000, maxTokens 16384, reasoning false, input `["text"]`, cost all-zero —
 * matching pi.dev's own documented defaults) — no change to `pi.ts`'s actual
 * request path.
 *
 * A custom provider's API key is **not** stored in this module's table —
 * `providerCredentials.ts`'s `provider_credentials` table already stores one
 * key per free-text provider id with no allowlist FK, so a custom provider's
 * id just becomes another row there (see that module's relaxed
 * `isDilnaProvider(p) || isCustomProvider(p)` gate). That reuses the existing
 * masking/storage/resolution code entirely instead of duplicating it.
 */

export type CustomModelDef = { id: string; name?: string };

export type CustomProvider = {
	id: string;
	name: string;
	baseUrl: string;
	api: CustomProviderApi;
	models: CustomModelDef[];
};

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** In-memory mirror of the custom_providers rows, primed once at boot (like
 * providerCredentials.ts's `storedCredentials`) so provider/model resolution
 * on the agent-start hot path never hits SQLite. */
let customProvidersById = new Map<string, CustomProvider>();

function rowToCustomProvider(
	row: typeof customProvidersTable.$inferSelect,
): CustomProvider {
	return {
		id: row.id,
		name: row.name,
		baseUrl: row.baseUrl,
		api: row.api as CustomProviderApi,
		models: JSON.parse(row.modelsJson) as CustomModelDef[],
	};
}

function readCustomProvidersFromDb(): Map<string, CustomProvider> {
	const db = getDb();
	const rows = db.select().from(customProvidersTable).all();
	const map = new Map<string, CustomProvider>();
	for (const row of rows) map.set(row.id, rowToCustomProvider(row));
	return map;
}

/** Load custom provider rows into the module cache. Called once at boot
 * (index.ts), same as `providerCredentials.primeProviderCredentials`. */
export function primeCustomProviders(): void {
	customProvidersById = readCustomProvidersFromDb();
}

export function listCustomProviders(): CustomProvider[] {
	return [...customProvidersById.values()];
}

export function getCustomProvider(id: string): CustomProvider | undefined {
	return customProvidersById.get(id);
}

export function isCustomProvider(id: string): boolean {
	return customProvidersById.has(id);
}

export function customProviderModelIds(id: string): string[] {
	return (customProvidersById.get(id)?.models ?? []).map((m) => m.id);
}

export type CustomProviderInput = {
	id: string;
	name: string;
	baseUrl: string;
	api: string;
	models: CustomModelDef[];
};

export type SetCustomProviderResult =
	| { ok: true }
	| { ok: false; error: string };

/**
 * Validate and upsert a custom provider. `id` is immutable once created
 * (this is used for both create and update — the id is the conflict target);
 * the Settings UI disables the id field when editing.
 */
export function setCustomProvider(
	input: CustomProviderInput,
): SetCustomProviderResult {
	const id = input.id.trim();
	const name = input.name.trim();
	const baseUrl = input.baseUrl.trim();
	const api = input.api.trim();

	if (!PROVIDER_ID_PATTERN.test(id)) {
		return {
			ok: false,
			error:
				"Provider ID must start with a lowercase letter or digit and contain only lowercase letters, digits, and hyphens.",
		};
	}
	if (isDilnaProvider(id)) {
		return {
			ok: false,
			error: `"${id}" is already a built-in provider (${PROVIDER_ALLOWLIST.join(", ")}) — choose a different ID.`,
		};
	}
	if (!name) {
		return { ok: false, error: "Name can't be empty." };
	}
	if (!baseUrl) {
		return { ok: false, error: "Base URL can't be empty." };
	}
	if (!isCustomProviderApi(api)) {
		return {
			ok: false,
			error: `"${api || "(empty)"}" is not a supported API type. Valid values: ${CUSTOM_PROVIDER_APIS.join(", ")}`,
		};
	}
	const models = input.models
		.map((m) => ({ id: m.id.trim(), name: m.name?.trim() || undefined }))
		.filter((m) => m.id);
	if (models.length === 0) {
		return { ok: false, error: "Add at least one model." };
	}
	const seen = new Set<string>();
	for (const m of models) {
		if (seen.has(m.id)) {
			return { ok: false, error: `Duplicate model ID "${m.id}".` };
		}
		seen.add(m.id);
	}

	const db = getDb();
	const modelsJson = JSON.stringify(models);
	db.insert(customProvidersTable)
		.values({
			id,
			name,
			baseUrl,
			api,
			modelsJson,
			updatedAt: Math.floor(Date.now() / 1000),
		})
		.onConflictDoUpdate({
			target: customProvidersTable.id,
			set: {
				name,
				baseUrl,
				api,
				modelsJson,
				updatedAt: Math.floor(Date.now() / 1000),
			},
		})
		.run();
	customProvidersById.set(id, { id, name, baseUrl, api, models });
	return { ok: true };
}

/** Delete a custom provider and its stored API key (if any). Doesn't clear an
 * active override still pointing at it — matches the existing precedent for
 * a builtin provider's key being removed out from under an override; the
 * session-start path already throws a clear "no longer a valid combination"
 * error in that case (see `pi.ts`'s `resolveConfiguredModel`).
 *
 * Takes `clearApiKey` as a parameter rather than importing
 * `providerCredentials.ts` directly, to avoid a module cycle
 * (`providerCredentials.ts` imports `isCustomProvider` from this module). */
export function deleteCustomProvider(
	id: string,
	clearApiKey: (provider: string) => void,
): void {
	const db = getDb();
	db.delete(customProvidersTable).where(eq(customProvidersTable.id, id)).run();
	customProvidersById.delete(id);
	clearApiKey(id);
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

/**
 * Build the `Model` object pi-ai expects for one of this provider's models,
 * filling every field `models.json` would default (see this module's doc
 * comment). Returns `undefined` if `modelId` isn't one of this provider's
 * configured models.
 */
export function buildCustomModel(
	provider: CustomProvider,
	modelId: string,
): Model<CustomProviderApi> | undefined {
	const modelDef = provider.models.find((m) => m.id === modelId);
	if (!modelDef) return undefined;
	return {
		id: modelDef.id,
		name: modelDef.name || modelDef.id,
		api: provider.api,
		provider: provider.id,
		baseUrl: provider.baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEFAULT_MAX_TOKENS,
	};
}
