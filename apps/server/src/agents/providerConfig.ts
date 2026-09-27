import {
	customProviderApiSchema,
	type CustomProviderApi as SharedCustomProviderApi,
} from "@dilna/shared";
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
 * pi-agent-core's own estimator constant: `estimateTokens` charges every
 * message `Math.ceil(chars / 4)`. It is the baseline dilna's calibration
 * scales, and what providers without a measured constant keep using.
 */
export const LIBRARY_CHARS_PER_TOKEN = 4;

/**
 * Per-provider `charsPerToken` for dilna's own context estimator (issue
 * #270): tokens ≈ chars / constant, replacing the library's flat `chars/4`
 * on the estimation path. All four allowlisted providers run BPE tokenizers
 * trained on code-heavy multilingual corpora, which pack denser than the
 * plain-English `chars/4` assumption — fewer chars per token means the
 * flat constant *under*-counts, and under-counting is the dangerous
 * direction (compaction fires too late and the real window overflows), so
 * every value here sits below 4.
 *
 * These are the *initial priors* (ADR-0048), ordered by how much
 * non-English/code mass each provider's training mix is publicly known to
 * carry. The recorded measurement that replaces them is
 * `sessions/charCalibration.ts` + `scripts/measure-chars-per-token.ts`, run
 * over a real instance's `usage_events` (the provider-reported context
 * tokens #267 stamps are the ground truth) once real Sessions have
 * accumulated; until then the drift log and the Metrics page's drift list
 * flag any provider whose constant is wrong.
 */
export const PROVIDER_CHARS_PER_TOKEN: Record<DilnaProvider, number> = {
	anthropic: 3.8,
	deepseek: 3.5,
	moonshotai: 3.7,
	zai: 3.6,
};

/** The calibrated constant for `provider` — allowlisted providers get their
 * measured/prior value, anything else (custom providers, unknown ids) the
 * library's flat `chars/4`, i.e. exactly today's behavior. */
export function charsPerTokenFor(provider: string): number {
	return isDilnaProvider(provider)
		? PROVIDER_CHARS_PER_TOKEN[provider]
		: LIBRARY_CHARS_PER_TOKEN;
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
// Sourced from `@dilna/shared`'s schema rather than re-declared, so the
// server's validation and the web client's type can't drift — they did
// before, with the client typing `api` as a bare `string`.
export const CUSTOM_PROVIDER_APIS = customProviderApiSchema.options;
export type CustomProviderApi = SharedCustomProviderApi;

export function isCustomProviderApi(value: string): value is CustomProviderApi {
	return customProviderApiSchema.safeParse(value).success;
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
