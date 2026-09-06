import {
	ArrowLeft,
	KeyRound,
	LogIn,
	Pencil,
	Plus,
	RotateCcw,
	Save,
	X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
	api,
	type CustomModelInput,
	type CustomProviderView,
	type LlmConfig,
} from "@/api/client";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Props = {
	onBack: () => void;
};

/** The four `pi-ai` API shapes a custom provider can speak (see
 * apps/server/src/agents/providerConfig.ts's `CUSTOM_PROVIDER_APIS`), with
 * display labels for the dialog's select. */
const CUSTOM_PROVIDER_API_OPTIONS = [
	{
		value: "openai-completions",
		label: "OpenAI-compatible (Chat Completions)",
	},
	{ value: "openai-responses", label: "OpenAI-compatible (Responses)" },
	{ value: "anthropic-messages", label: "Anthropic Messages" },
	{ value: "google-generative-ai", label: "Google Generative AI" },
] as const;

/** One editable row in the "Add/Edit custom provider" dialog's model list. */
/** `key` is a client-only synthetic id (stable React list key across
 * add/remove), distinct from `id` (the model id field being edited). */
type CustomModelRow = { key: string; id: string; name: string };

function newCustomModelRow(): CustomModelRow {
	return { key: crypto.randomUUID(), id: "", name: "" };
}

/**
 * Settings view for overall LLM config: which provider/model new sessions run
 * on (ADR-0020), plus, layered under it, the multi-provider key store.
 *
 * Historically dilna authenticated every provider purely through env vars
 * (`DILNA_PROVIDER`/`DILNA_MODEL` plus the matching `*_API_KEY` host
 * passthrough, ADR-0005). The "Model provider" form still picks one
 * provider/model the way it always did — an *override* persisted in the
 * `llm_config` table and served by `/api/config`, with env as the fallback
 * when the override is cleared.
 *
 * The "Added providers" section is what makes *multiple* providers usable at
 * once (multi-provider support): each row is a provider whose API key you've
 * stored in Settings (providerCredentials.ts), taking precedence over that
 * provider's env var. Typing a key into "Add a provider" doesn't pick the
 * running model — it just makes that provider selectable — so you configure
 * several providers, then choose which one new sessions run on above. New
 * sessions snapshot that choice at create time; existing sessions keep the
 * model they started on.
 */
export function SettingsPage({ onBack }: Props) {
	const [config, setConfig] = useState<LlmConfig | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadError, setLoadError] = useState<string | null>(null);

	const [provider, setProvider] = useState("");
	const [model, setModel] = useState("");
	const [saving, setSaving] = useState(false);
	const [clearPending, setClearPending] = useState(false);
	const [message, setMessage] = useState<{
		kind: "ok" | "error";
		text: string;
	} | null>(null);

	/** "Add a provider" dialog (multi-provider — see providerCredentials.ts):
	 * holds whether it's open, the API key field, the provider being added, and
	 * a submitting/error surface independent of the model-form `message` above. */
	const [addOpen, setAddOpen] = useState(false);
	const [addProvider, setAddProvider] = useState("");
	const [addKey, setAddKey] = useState("");
	const [addPending, setAddPending] = useState(false);
	const [addError, setAddError] = useState<string | null>(null);

	/** "Sign in with Claude" dialog (Anthropic OAuth — see providerOAuth.ts):
	 * `oauthLoginId`/`oauthAuthUrl` populate once `startAnthropicOAuthLogin`
	 * returns; the paste-back field feeds `completeAnthropicOAuthLogin`. */
	const [oauthOpen, setOauthOpen] = useState(false);
	const [oauthLoginId, setOauthLoginId] = useState<string | null>(null);
	const [oauthAuthUrl, setOauthAuthUrl] = useState<string | null>(null);
	const [oauthStarting, setOauthStarting] = useState(false);
	const [oauthInput, setOauthInput] = useState("");
	const [oauthSubmitting, setOauthSubmitting] = useState(false);
	const [oauthError, setOauthError] = useState<string | null>(null);

	/** "Add/Edit custom provider" dialog (Ollama, LM Studio, vLLM, ... — see
	 * customProviders.ts): `customEditingId` is `null` in create mode, or the
	 * provider's id in edit mode (the ID field is disabled then, since it's
	 * immutable). */
	const [customOpen, setCustomOpen] = useState(false);
	const [customEditingId, setCustomEditingId] = useState<string | null>(null);
	const [customId, setCustomId] = useState("");
	const [customName, setCustomName] = useState("");
	const [customBaseUrl, setCustomBaseUrl] = useState("");
	const [customApi, setCustomApi] = useState<string>(
		CUSTOM_PROVIDER_API_OPTIONS[0].value,
	);
	const [customApiKey, setCustomApiKey] = useState("");
	const [customModels, setCustomModels] = useState<CustomModelRow[]>([
		newCustomModelRow(),
	]);
	const [customPending, setCustomPending] = useState(false);
	const [customError, setCustomError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		api.config
			.get()
			.then((cfg) => {
				if (cancelled) return;
				setConfig(cfg);
				// Prefill from the persisted override when present, else the env
				// default — the selection the form will apply on Save.
				const pre = cfg.override ?? {
					provider: cfg.envDefault.provider,
					model: cfg.envDefault.model,
				};
				if (pre.provider) setProvider(pre.provider);
				if (pre.model) setModel(pre.model);
			})
			.catch((e) => {
				if (!cancelled) {
					setLoadError(
						e instanceof Error ? e.message : "failed to load settings",
					);
				}
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// Persisted-override or env-default source of the current form selection —
	// toggling the provider keeps model selection scoped to that provider by
	// re-picking the first (or effective) model for it. The user always ends
	// on a concrete, valid combo rather than a provider with no model.
	const selectedProvider = provider || config?.effective.provider || "";

	const modelOptions = useMemo(
		() =>
			config && selectedProvider
				? (config.modelsByProvider[selectedProvider] ?? [])
				: [],
		[config, selectedProvider],
	);

	function handleProviderChange(value: string) {
		setProvider(value);
		const opts = config?.modelsByProvider[value] ?? [];
		// Keep the current model if it's valid for the new provider, else jump
		// to the provider's first model.
		if (opts.some((m) => m.id === model)) return;
		setModel(opts[0]?.id ?? "");
	}

	async function handleSave(e: React.FormEvent) {
		e.preventDefault();
		if (!provider || !model) return;
		setSaving(true);
		setMessage(null);
		try {
			await api.config.setOverride(provider, model);
			const cfg = await api.config.get();
			setConfig(cfg);
			setMessage({
				kind: "ok",
				text: "Saved — new sessions will use this provider/model.",
			});
		} catch (err) {
			setMessage({
				kind: "error",
				text: err instanceof Error ? err.message : "failed to save",
			});
		} finally {
			setSaving(false);
		}
	}

	async function handleClear() {
		setClearPending(true);
		setMessage(null);
		try {
			await api.config.clearOverride();
			const cfg = await api.config.get();
			setConfig(cfg);
			// Reflect the env fallback as the new active selection.
			if (cfg.envDefault.provider) setProvider(cfg.envDefault.provider);
			if (cfg.envDefault.model) setModel(cfg.envDefault.model);
			setMessage({
				kind: "ok",
				text: "Override cleared — falling back to DILNA_PROVIDER/DILNA_MODEL.",
			});
		} catch (err) {
			setMessage({
				kind: "error",
				text: err instanceof Error ? err.message : "failed to clear override",
			});
		} finally {
			setClearPending(false);
		}
	}

	function openAddProvider() {
		setAddProvider(addableProviders[0] ?? "");
		setAddKey("");
		setAddError(null);
		setAddOpen(true);
	}

	async function handleAddProvider(e: React.FormEvent) {
		e.preventDefault();
		if (!addProvider || !addKey.trim()) return;
		setAddPending(true);
		setAddError(null);
		try {
			await api.config.setCredential(addProvider, addKey.trim());
			setAddOpen(false);
			// Refresh so the list + the model selector reflect the new key.
			const cfg = await api.config.get();
			setConfig(cfg);
			// Point at the newly-added provider's first model as a convenience.
			setProvider(addProvider);
			const opts = cfg.modelsByProvider[addProvider] ?? [];
			setModel(opts[0]?.id ?? "");
			setMessage({ kind: "ok", text: "API key saved for this provider." });
		} catch (err) {
			setAddError(err instanceof Error ? err.message : "failed to save key");
		} finally {
			setAddPending(false);
		}
	}

	async function handleRemoveProvider(provider: string) {
		setMessage(null);
		try {
			await api.config.deleteCredential(provider);
			const cfg = await api.config.get();
			setConfig(cfg);
			setMessage({
				kind: "ok",
				text: `No longer storing a key for ${provider}.`,
			});
		} catch (err) {
			setMessage({
				kind: "error",
				text: err instanceof Error ? err.message : "failed to remove provider",
			});
		}
	}

	async function openOAuthDialog() {
		setOauthOpen(true);
		setOauthStarting(true);
		setOauthError(null);
		setOauthAuthUrl(null);
		setOauthLoginId(null);
		setOauthInput("");
		try {
			const { loginId, authUrl } = await api.config.startAnthropicOAuthLogin();
			setOauthLoginId(loginId);
			setOauthAuthUrl(authUrl);
		} catch (err) {
			setOauthError(
				err instanceof Error ? err.message : "failed to start login",
			);
		} finally {
			setOauthStarting(false);
		}
	}

	function handleOAuthOpenChange(open: boolean) {
		// Closing without completing abandons the pending login server-side —
		// otherwise it'd sit around consuming the local callback race until its
		// own TTL sweep (see providerOAuth.ts).
		if (!open && oauthLoginId) {
			void api.config.cancelAnthropicOAuthLogin(oauthLoginId);
		}
		setOauthOpen(open);
	}

	async function handleOAuthSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!oauthLoginId || !oauthInput.trim()) return;
		setOauthSubmitting(true);
		setOauthError(null);
		try {
			await api.config.completeAnthropicOAuthLogin(
				oauthLoginId,
				oauthInput.trim(),
			);
			setOauthOpen(false);
			setOauthLoginId(null);
			const cfg = await api.config.get();
			setConfig(cfg);
			setMessage({ kind: "ok", text: "Signed in with Claude." });
		} catch (err) {
			setOauthError(
				err instanceof Error ? err.message : "failed to complete login",
			);
		} finally {
			setOauthSubmitting(false);
		}
	}

	async function handleDisconnectOAuth() {
		setMessage(null);
		try {
			await api.config.disconnectAnthropicOAuth();
			const cfg = await api.config.get();
			setConfig(cfg);
			setMessage({ kind: "ok", text: "Disconnected Claude Pro/Max login." });
		} catch (err) {
			setMessage({
				kind: "error",
				text: err instanceof Error ? err.message : "failed to disconnect",
			});
		}
	}

	function openAddCustomProvider() {
		setCustomEditingId(null);
		setCustomId("");
		setCustomName("");
		setCustomBaseUrl("");
		setCustomApi(CUSTOM_PROVIDER_API_OPTIONS[0].value);
		setCustomApiKey("");
		setCustomModels([newCustomModelRow()]);
		setCustomError(null);
		setCustomOpen(true);
	}

	function openEditCustomProvider(cp: CustomProviderView) {
		setCustomEditingId(cp.id);
		setCustomId(cp.id);
		setCustomName(cp.name);
		setCustomBaseUrl(cp.baseUrl);
		setCustomApi(cp.api);
		setCustomApiKey("");
		setCustomModels(
			cp.models.length > 0
				? cp.models.map((m) => ({
						key: crypto.randomUUID(),
						id: m.id,
						name: m.name ?? "",
					}))
				: [newCustomModelRow()],
		);
		setCustomError(null);
		setCustomOpen(true);
	}

	function updateCustomModelRow(
		index: number,
		field: "id" | "name",
		value: string,
	) {
		setCustomModels((rows) =>
			rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)),
		);
	}

	function addCustomModelRow() {
		setCustomModels((rows) => [...rows, newCustomModelRow()]);
	}

	function removeCustomModelRow(index: number) {
		setCustomModels((rows) => rows.filter((_, i) => i !== index));
	}

	async function handleSubmitCustomProvider(e: React.FormEvent) {
		e.preventDefault();
		const models: CustomModelInput[] = customModels
			.map((row) => ({ id: row.id.trim(), name: row.name.trim() || undefined }))
			.filter((row) => row.id);
		if (!customId.trim() || !customName.trim() || !customBaseUrl.trim()) return;
		if (models.length === 0) return;

		setCustomPending(true);
		setCustomError(null);
		try {
			const fields = {
				name: customName.trim(),
				baseUrl: customBaseUrl.trim(),
				api: customApi,
				apiKey: customApiKey.trim() || undefined,
				models,
			};
			if (customEditingId) {
				await api.config.updateCustomProvider(customEditingId, fields);
			} else {
				await api.config.createCustomProvider({
					id: customId.trim(),
					...fields,
				});
			}
			setCustomOpen(false);
			const cfg = await api.config.get();
			setConfig(cfg);
			setMessage({
				kind: "ok",
				text: customEditingId
					? "Custom provider updated."
					: "Custom provider added.",
			});
		} catch (err) {
			setCustomError(
				err instanceof Error ? err.message : "failed to save custom provider",
			);
		} finally {
			setCustomPending(false);
		}
	}

	async function handleDeleteCustomProvider(id: string) {
		setMessage(null);
		try {
			await api.config.deleteCustomProvider(id);
			const cfg = await api.config.get();
			setConfig(cfg);
			setMessage({ kind: "ok", text: `Removed custom provider "${id}".` });
		} catch (err) {
			setMessage({
				kind: "error",
				text: err instanceof Error ? err.message : "failed to remove provider",
			});
		}
	}

	// Custom providers (Ollama, LM Studio, vLLM, ... — see customProviders.ts)
	// get their own management section below, so they're excluded from the
	// builtin-key "Added providers" list/dialog even though a custom
	// provider's key lives in the same store (providerCredentials.ts).
	const customProviders = config?.customProviders ?? [];
	const customProviderIds = new Set(customProviders.map((p) => p.id));

	// Providers that have a dilna-managed (stored) API key, driving the
	// "Added providers" list. Config carries these from GET /api/config; the
	// test fixture may omit the field, so default to [] rather than crash.
	const storedProviders = (config?.keyedStoredProviders ?? []).filter(
		(r) => !customProviderIds.has(r.provider),
	);
	const storedSet = new Set(storedProviders.map((r) => r.provider));
	// Providers already on the list, so the Add dialog excludes them.
	const addableProviders = Object.keys(config?.modelsByProvider ?? {}).filter(
		(p) => !storedSet.has(p) && !customProviderIds.has(p),
	);

	const hasOverride = Boolean(config?.override);
	const providerHasKey =
		!!config &&
		!!selectedProvider &&
		config.apiKeysConfigured[selectedProvider] === true;

	// Which provider actually runs current sessions (override ?? env).
	const activeProvider = config?.effective.provider || "";
	const usingEnv = !hasOverride && !!config?.envDefault.provider;

	// Anthropic OAuth ("Sign in with Claude") — outranks a stored Anthropic API
	// key when connected (see providerCredentials.ts). Config carries this from
	// GET /api/config; the test fixture may omit the field.
	const anthropicOAuthConnected = config?.oauthConnected?.anthropic ?? false;

	return (
		<div className="flex flex-1 flex-col overflow-y-auto">
			<header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
				<Button variant="ghost" size="icon" onClick={onBack} title="Back">
					<ArrowLeft className="size-4" />
				</Button>
				<h1 className="font-semibold tracking-tight">Settings</h1>
			</header>

			<div className="mx-auto w-full max-w-xl flex-1 p-6">
				{loadError && (
					<p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
						{loadError}
					</p>
				)}

				{!loadError && loading && !config && (
					<p className="text-sm text-muted-foreground">Loading…</p>
				)}

				{config && (
					<>
						<form onSubmit={handleSave} className="space-y-5">
							<div>
								<h2 className="text-lg font-semibold tracking-tight">
									Model provider
								</h2>
								<p className="mt-0.5 text-sm text-muted-foreground">
									dilna runs every session on one provider/model. Pick the one
									to use going forward — this saves an instance-wide override
									and applies to any new session immediately.
								</p>
							</div>

							{/* Active-now summary */}
							<div className="rounded-xl border border-border bg-card p-3 text-sm shadow-sm">
								<p className="text-xs text-muted-foreground">
									Currently in effect
								</p>
								<p className="mt-1">
									<span className="font-mono">{config.effective.provider}</span>
									{" / "}
									<span className="font-mono">{config.effective.model}</span>
									{usingEnv && (
										<span className="ml-2 text-xs text-muted-foreground">
											(from env)
										</span>
									)}
									{hasOverride && (
										<span className="ml-2 text-xs text-muted-foreground">
											(override set)
										</span>
									)}
								</p>
								{activeProvider &&
									config.apiKeysConfigured[activeProvider] === false && (
										<p className="mt-2 flex items-start gap-1.5 rounded-md bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
											<KeyRound className="mt-0.5 size-3.5 shrink-0" />
											No API key is configured for{" "}
											<span className="font-mono">{activeProvider}</span>. Agent
											turns will fail until its key env var (e.g.{" "}
											<span className="font-mono">ANTHROPIC_API_KEY</span>) is
											set.
										</p>
									)}
							</div>

							<div className="space-y-1.5">
								<Label htmlFor="settings-provider">Provider</Label>
								<select
									id="settings-provider"
									value={provider || ""}
									onChange={(e) => handleProviderChange(e.target.value)}
									className={cn(
										"h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm transition-[color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
									)}
								>
									<option value="" disabled>
										Select a provider…
									</option>
									{Object.keys(config.modelsByProvider).map((p) => (
										<option key={p} value={p}>
											{p}
											{config.apiKeysConfigured[p]
												? ""
												: " (no API key in env)"}
										</option>
									))}
								</select>
								{selectedProvider && !providerHasKey && (
									<p className="text-xs text-muted-foreground">
										No API key is configured in the environment for{" "}
										<span className="font-mono">{selectedProvider}</span> —
										saving will be rejected until one is set.
									</p>
								)}
							</div>

							<div className="space-y-1.5">
								<Label htmlFor="settings-model">Model</Label>
								<select
									id="settings-model"
									value={model || ""}
									onChange={(e) => setModel(e.target.value)}
									disabled={!selectedProvider || modelOptions.length === 0}
									className={cn(
										"h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
									)}
								>
									{modelOptions.length === 0 && (
										<option value="">No model loaded</option>
									)}
									{modelOptions.map((m) => (
										<option key={m.id} value={m.id}>
											{m.name} ({m.id})
										</option>
									))}
								</select>
							</div>

							{message && (
								<p
									className={cn(
										"rounded-lg border px-3 py-2 text-sm",
										message.kind === "ok"
											? "border-border bg-card text-foreground"
											: "border-destructive/30 bg-destructive/10 text-destructive",
									)}
								>
									{message.text}
								</p>
							)}

							<div className="flex items-center gap-2 pt-1">
								<Button type="submit" disabled={saving || !provider || !model}>
									<Save className="mr-1.5 size-4" />
									{saving ? "Saving…" : "Save provider/model"}
								</Button>
								<Button
									type="button"
									variant="outline"
									onClick={handleClear}
									disabled={clearPending || !hasOverride}
									title={
										hasOverride
											? "Return to the env-configured provider/model"
											: "No override set — already using the env default"
									}
								>
									<RotateCcw className="mr-1.5 size-4" />
									{clearPending ? "Resetting…" : "Use env default"}
								</Button>
							</div>
						</form>

						{/* Multi-provider: providers whose key dilna stores itself (see
							providerCredentials.ts) rather than reads from an env var only. */}
						<div className="space-y-3 border-t border-border pt-4">
							<div className="flex items-center justify-between">
								<h2 className="text-lg font-semibold tracking-tight">
									Added providers
								</h2>
								<Button
									type="button"
									variant="outline"
									onClick={openAddProvider}
								>
									<Plus className="mr-1.5 size-4" />
									Add a provider
								</Button>
							</div>
							<p className="text-xs text-muted-foreground">
								A provider is usable once it has a key — stored here (in dilna's
								db, taking precedence over the env var for that provider) or via
								its env var.
							</p>
							{storedProviders.length === 0 ? (
								<p className="text-sm text-muted-foreground">
									No keys stored in Settings — add one below, or keep using{" "}
									<span className="font-mono">*_API_KEY</span> env vars as
									before.
								</p>
							) : (
								<ul className="space-y-1.5">
									{storedProviders.map((r) => (
										<li
											key={r.provider}
											className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
										>
											<span className="font-mono">{r.provider}</span>
											<span className="ml-1 text-xs text-muted-foreground">
												API key stored
											</span>
											<button
												type="button"
												onClick={() => void handleRemoveProvider(r.provider)}
												title={`Remove stored key for ${r.provider}`}
												aria-label={`Remove ${r.provider} key`}
												className="ml-auto rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
											>
												<X className="size-3.5" />
											</button>
										</li>
									))}
								</ul>
							)}
						</div>

						{/* Anthropic OAuth ("Sign in with Claude" — see providerOAuth.ts).
							Independent of the stored-API-key list above: a connected login
							outranks a stored Anthropic key, but doesn't replace it — both
							can be kept around at once. */}
						<div className="space-y-2 border-t border-border pt-4">
							<div className="flex items-center justify-between gap-3">
								<div>
									<h2 className="text-lg font-semibold tracking-tight">
										Claude Pro/Max login
									</h2>
									<p className="mt-0.5 text-xs text-muted-foreground">
										Sign in with a Claude Pro/Max subscription instead of an API
										key. Takes precedence over a stored Anthropic key.
									</p>
								</div>
								{!anthropicOAuthConnected && (
									<Button
										type="button"
										variant="outline"
										onClick={() => void openOAuthDialog()}
									>
										<LogIn className="mr-1.5 size-4" />
										Sign in with Claude
									</Button>
								)}
							</div>
							{anthropicOAuthConnected && (
								<div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
									<span className="text-sm">Connected — Claude Pro/Max</span>
									<button
										type="button"
										onClick={() => void handleDisconnectOAuth()}
										title="Disconnect Claude Pro/Max login"
										aria-label="Disconnect Claude Pro/Max login"
										className="ml-auto rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
									>
										<X className="size-3.5" />
									</button>
								</div>
							)}
						</div>

						{/* Custom providers (Ollama, LM Studio, vLLM, or anything else
							speaking one of pi-ai's 4 supported API shapes — see
							customProviders.ts). A custom provider's key lives in the same
							store as a builtin provider's, but is managed here, together
							with the rest of its definition, rather than in "Added
							providers" above. */}
						<div className="space-y-3 border-t border-border pt-4">
							<div className="flex items-center justify-between">
								<div>
									<h2 className="text-lg font-semibold tracking-tight">
										Custom providers
									</h2>
									<p className="mt-0.5 text-xs text-muted-foreground">
										Point at Ollama, LM Studio, vLLM, or anything else speaking
										OpenAI Completions, OpenAI Responses, Anthropic Messages, or
										Google Generative AI.
									</p>
								</div>
								<Button
									type="button"
									variant="outline"
									onClick={openAddCustomProvider}
								>
									<Plus className="mr-1.5 size-4" />
									Add custom provider
								</Button>
							</div>
							{customProviders.length === 0 ? (
								<p className="text-sm text-muted-foreground">
									No custom providers configured yet.
								</p>
							) : (
								<ul className="space-y-1.5">
									{customProviders.map((cp) => (
										<li
											key={cp.id}
											className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2"
										>
											<div className="min-w-0">
												<div className="flex items-center gap-1.5">
													<span className="font-mono">{cp.id}</span>
													<span className="text-xs text-muted-foreground">
														{cp.name}
													</span>
												</div>
												<p className="truncate text-xs text-muted-foreground">
													{cp.baseUrl} · {cp.models.length}{" "}
													{cp.models.length === 1 ? "model" : "models"}
												</p>
											</div>
											<button
												type="button"
												onClick={() => openEditCustomProvider(cp)}
												title={`Edit ${cp.id}`}
												aria-label={`Edit ${cp.id}`}
												className="ml-auto rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
											>
												<Pencil className="size-3.5" />
											</button>
											<button
												type="button"
												onClick={() => void handleDeleteCustomProvider(cp.id)}
												title={`Remove ${cp.id}`}
												aria-label={`Remove ${cp.id}`}
												className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
											>
												<X className="size-3.5" />
											</button>
										</li>
									))}
								</ul>
							)}
						</div>
					</>
				)}

				<Dialog open={addOpen} onOpenChange={setAddOpen}>
					<DialogContent className="sm:max-w-md">
						<DialogHeader>
							<DialogTitle>Add a provider</DialogTitle>
							<DialogDescription>
								Add an API key for another provider so you can select it for new
								sessions without setting its key env var on the host.
							</DialogDescription>
						</DialogHeader>
						<form
							id="add-provider-form"
							onSubmit={handleAddProvider}
							className="space-y-4"
						>
							<div className="space-y-1.5">
								<Label htmlFor="add-provider">Provider</Label>
								<select
									id="add-provider"
									value={addProvider}
									onChange={(e) => setAddProvider(e.target.value)}
									className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									<option value="" disabled>
										Select a provider…
									</option>
									{addableProviders.map((p) => (
										<option key={p} value={p}>
											{p}
										</option>
									))}
								</select>
								<p className="text-xs text-muted-foreground">
									Any provider already listed above (Added providers) can't be
									re-added.
								</p>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="add-key">API key</Label>
								<Input
									id="add-key"
									type="password"
									placeholder="sk-…"
									value={addKey}
									onChange={(e) => setAddKey(e.target.value)}
									autoComplete="off"
								/>
							</div>
							<p className="text-xs text-muted-foreground">
								Stored in dilna's own database, not in the environment. Stored
								keys take precedence over the matching env var.
							</p>
							{addError && (
								<p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
									{addError}
								</p>
							)}
						</form>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setAddOpen(false)}
								disabled={addPending}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								form="add-provider-form"
								disabled={addPending || !addProvider || !addKey.trim()}
							>
								{addPending ? "Saving…" : "Save key"}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>

				<Dialog open={oauthOpen} onOpenChange={handleOAuthOpenChange}>
					<DialogContent className="sm:max-w-md">
						<DialogHeader>
							<DialogTitle>Sign in with Claude</DialogTitle>
							<DialogDescription>
								Opens Anthropic's login in a new tab. After approving, paste the
								code — or the full redirect URL if it doesn't land back here
								automatically — into the field below to finish connecting.
							</DialogDescription>
						</DialogHeader>
						{oauthStarting && (
							<p className="text-sm text-muted-foreground">
								Preparing sign-in…
							</p>
						)}
						{oauthAuthUrl && (
							<form
								id="oauth-login-form"
								onSubmit={handleOAuthSubmit}
								className="space-y-4"
							>
								<a
									href={oauthAuthUrl}
									target="_blank"
									rel="noreferrer"
									className="text-sm text-primary underline underline-offset-2"
								>
									Open Anthropic's login page
								</a>
								<div className="space-y-1.5">
									<Label htmlFor="oauth-input">Code or redirect URL</Label>
									<Input
										id="oauth-input"
										placeholder="Paste here after approving"
										value={oauthInput}
										onChange={(e) => setOauthInput(e.target.value)}
										autoComplete="off"
									/>
								</div>
							</form>
						)}
						{oauthError && (
							<p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
								{oauthError}
							</p>
						)}
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => handleOAuthOpenChange(false)}
								disabled={oauthSubmitting}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								form="oauth-login-form"
								disabled={
									!oauthAuthUrl || oauthSubmitting || !oauthInput.trim()
								}
							>
								{oauthSubmitting ? "Connecting…" : "Connect"}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>

				<Dialog open={customOpen} onOpenChange={setCustomOpen}>
					<DialogContent className="sm:max-w-lg">
						<DialogHeader>
							<DialogTitle>
								{customEditingId
									? `Edit ${customEditingId}`
									: "Add custom provider"}
							</DialogTitle>
							<DialogDescription>
								Point at Ollama, LM Studio, vLLM, or anything else speaking
								OpenAI Completions, OpenAI Responses, Anthropic Messages, or
								Google Generative AI.
							</DialogDescription>
						</DialogHeader>
						<form
							id="custom-provider-form"
							onSubmit={handleSubmitCustomProvider}
							className="space-y-4"
						>
							<div className="space-y-1.5">
								<Label htmlFor="custom-id">Provider ID</Label>
								<Input
									id="custom-id"
									placeholder="ollama"
									value={customId}
									onChange={(e) => setCustomId(e.target.value)}
									disabled={!!customEditingId}
									autoComplete="off"
								/>
								<p className="text-xs text-muted-foreground">
									Lowercase letters, digits, and hyphens only. Can't be changed
									later.
								</p>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="custom-name">Name</Label>
								<Input
									id="custom-name"
									placeholder="Ollama"
									value={customName}
									onChange={(e) => setCustomName(e.target.value)}
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="custom-base-url">Base URL</Label>
								<Input
									id="custom-base-url"
									placeholder="http://localhost:11434/v1"
									value={customBaseUrl}
									onChange={(e) => setCustomBaseUrl(e.target.value)}
									autoComplete="off"
								/>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="custom-api">API type</Label>
								<select
									id="custom-api"
									value={customApi}
									onChange={(e) => setCustomApi(e.target.value)}
									className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									{CUSTOM_PROVIDER_API_OPTIONS.map((opt) => (
										<option key={opt.value} value={opt.value}>
											{opt.label}
										</option>
									))}
								</select>
							</div>
							<div className="space-y-1.5">
								<Label htmlFor="custom-api-key">API key</Label>
								<Input
									id="custom-api-key"
									type="password"
									placeholder={
										customEditingId
											? "Leave blank to keep the current key"
											: "sk-…"
									}
									value={customApiKey}
									onChange={(e) => setCustomApiKey(e.target.value)}
									autoComplete="off"
								/>
								<p className="text-xs text-muted-foreground">
									{customEditingId
										? "Leave blank to keep the currently stored key."
										: "Required — for a keyless local server like Ollama, any placeholder value works."}
								</p>
							</div>
							<div className="space-y-1.5">
								<Label>Models</Label>
								<div className="space-y-2">
									{customModels.map((row, i) => (
										<div key={row.key} className="flex items-center gap-2">
											<Input
												placeholder="Model ID (e.g. llama3.1:8b)"
												value={row.id}
												onChange={(e) =>
													updateCustomModelRow(i, "id", e.target.value)
												}
												autoComplete="off"
											/>
											<Input
												placeholder="Display name (optional)"
												value={row.name}
												onChange={(e) =>
													updateCustomModelRow(i, "name", e.target.value)
												}
												autoComplete="off"
											/>
											<button
												type="button"
												onClick={() => removeCustomModelRow(i)}
												title="Remove model"
												aria-label="Remove model"
												disabled={customModels.length === 1}
												className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive disabled:cursor-not-allowed disabled:opacity-50"
											>
												<X className="size-3.5" />
											</button>
										</div>
									))}
								</div>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={addCustomModelRow}
								>
									<Plus className="mr-1.5 size-4" />
									Add model
								</Button>
							</div>
							{customError && (
								<p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
									{customError}
								</p>
							)}
						</form>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								onClick={() => setCustomOpen(false)}
								disabled={customPending}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								form="custom-provider-form"
								disabled={
									customPending ||
									!customId.trim() ||
									!customName.trim() ||
									!customBaseUrl.trim() ||
									!customModels.some((m) => m.id.trim())
								}
							>
								{customPending
									? "Saving…"
									: customEditingId
										? "Save changes"
										: "Add provider"}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</div>
		</div>
	);
}
