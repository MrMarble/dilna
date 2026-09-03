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

type ProviderModelOption = { id: string; name: string };

type GetConfigResponse = {
	/** The persisted override (single provider/model chosen in Settings), or
	 * null when dilna is falling back to the env vars. */
	override: { provider: string; model: string } | null;
	/** Raw DILNA_PROVIDER/DILNA_MODEL env values (may be empty strings/null
	 * when unset). */
	envDefault: { provider: string; model: string };
	/** The provider/model currently in effect: override if set, else env. */
	effective: { provider: string; model: string };
	/** Which of the allowlisted providers has an API key configured in env —
	 * lets the form steer the user and explain why a choice is disabled. */
	apiKeysConfigured: Record<string, boolean>;
	/** Provider -> selectable models for the dropdown. */
	modelsByProvider: Record<string, ProviderModelOption[]>;
};

export const configRoute = new Hono();

function modelsFor(provider: DilnaProvider): ProviderModelOption[] {
	return getBuiltinModels(provider).map((m) => ({ id: m.id, name: m.name }));
}

configRoute.get("/", (c) => {
	const override = getOverride();
	const envProvider = process.env.DILNA_PROVIDER ?? "";
	const envModel = process.env.DILNA_MODEL ?? "";
	const modelsByProvider: Record<string, ProviderModelOption[]> = {};
	for (const provider of PROVIDER_ALLOWLIST) {
		modelsByProvider[provider] = modelsFor(provider);
	}
	const apiKeysConfigured: Record<string, boolean> = {};
	for (const provider of PROVIDER_ALLOWLIST) {
		apiKeysConfigured[provider] = providerApiKeyConfigured(provider);
	}
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
	const result = setOverride(body.provider, body.model);
	if (!result.ok) {
		throw new HTTPException(400, { message: result.error });
	}
	return c.json({ ok: true, override: getOverride() });
});

configRoute.delete("/", (c) => {
	clearOverride();
	return c.json({ ok: true, override: null });
});
