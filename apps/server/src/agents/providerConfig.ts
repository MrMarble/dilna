import { getEnvApiKey } from "@earendil-works/pi-ai/compat";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

/**
 * dilna's own v1 provider allowlist — a deliberate subset of `pi-ai`'s ~37
 * built-in providers, not a completeness check against its full catalog (see
 * docs/research/pi-provider-model-config.md). `kimi-coding` and every
 * `-cn` regional variant are intentionally excluded: `kimi-coding`'s catalog
 * (`k3`, `kimi-for-coding`) is a different provider from the Kimi K2 model
 * family, which lives under `moonshotai`/`moonshotai-cn` — a mixup ADR-0020
 * itself once made and corrected.
 */
export const PROVIDER_ALLOWLIST = [
	"anthropic",
	"deepseek",
	"moonshotai",
	"zai",
] as const;
export type DilnaProvider = (typeof PROVIDER_ALLOWLIST)[number];

export function isDilnaProvider(value: string): value is DilnaProvider {
	return (PROVIDER_ALLOWLIST as readonly string[]).includes(value);
}

/**
 * The `pi-ai` `Api` shapes dilna's custom-provider support (customProviders.ts)
 * lets a user pick from — the same four kinds pi's own `models.json` supports
 * (see https://pi.dev/docs/latest/models): OpenAI Chat Completions, OpenAI
 * Responses, Anthropic Messages, and Google Generative AI. A custom provider
 * is just a `Model<Api>` dilna constructs itself (baseUrl + api + a plain
 * apiKey string), not a `pi-ai` `Provider`/auth-registry entry — see that
 * module's doc comment for why no further abstraction is needed.
 */
export const CUSTOM_PROVIDER_APIS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
] as const;
export type CustomProviderApi = (typeof CUSTOM_PROVIDER_APIS)[number];

export function isCustomProviderApi(value: string): value is CustomProviderApi {
	return (CUSTOM_PROVIDER_APIS as readonly string[]).includes(value);
}

/**
 * Model ids available for a provider, straight from pi-ai's generated
 * catalog. Pure and exportable so the config store can validate a proposed
 * override's model against what actually exists for its provider without
 * importing the catalog directly there. The Settings *route* pulls the
 * richer id+name options separately (it wants a display label too).
 */
export function catalogModelIds(provider: DilnaProvider): string[] {
	return getBuiltinModels(provider).map((m) => m.id);
}

export type ProviderConfigResult =
	| { ok: true; provider: DilnaProvider; model: string }
	| { ok: false; error: string };

/**
 * Validate `DILNA_PROVIDER`/`DILNA_MODEL` plus the matching provider API-key
 * env var, at server startup (see `index.ts`). No defaults for either var —
 * `claude.ts` never pinned a model id, so there's no pre-existing default to
 * preserve (see the design doc's §5).
 *
 * `deps` lets tests stub `getBuiltinModels`/`getEnvApiKey` — in particular to
 * assert the catalog call never happens for an out-of-allowlist provider
 * (the whole point of validating the allowlist first). Both real functions
 * are fast, synchronous, and hit no network (`getBuiltinModels` reads a
 * static generated catalog), so production code always uses the real ones.
 */
export function validateProviderConfig(
	env: NodeJS.ProcessEnv,
	deps: {
		getBuiltinModels?: typeof getBuiltinModels;
		getEnvApiKey?: typeof getEnvApiKey;
	} = {},
): ProviderConfigResult {
	const getModels = deps.getBuiltinModels ?? getBuiltinModels;
	const getKey = deps.getEnvApiKey ?? getEnvApiKey;

	const provider = env.DILNA_PROVIDER;
	if (!provider) {
		return {
			ok: false,
			error: `DILNA_PROVIDER is not set. Valid values: ${PROVIDER_ALLOWLIST.join(", ")}`,
		};
	}
	if (!isDilnaProvider(provider)) {
		return {
			ok: false,
			error: `DILNA_PROVIDER=${provider} is not a supported provider. Valid values: ${PROVIDER_ALLOWLIST.join(", ")}`,
		};
	}

	const model = env.DILNA_MODEL;
	if (!model) {
		return { ok: false, error: "DILNA_MODEL is not set." };
	}
	const models = getModels(provider);
	if (!models.some((m) => m.id === model)) {
		return {
			ok: false,
			error: `DILNA_MODEL=${model} is not a known model for provider "${provider}". Known models: ${models.map((m) => m.id).join(", ")}`,
		};
	}

	const apiKey = getKey(provider, env as Record<string, string>);
	if (!apiKey) {
		return {
			ok: false,
			error: `No API key configured for provider "${provider}" — set its matching env var (e.g. ANTHROPIC_API_KEY for "anthropic").`,
		};
	}

	return { ok: true, provider, model };
}
