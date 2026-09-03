import { ArrowLeft, KeyRound, RotateCcw, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, type LlmConfig } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Props = {
	onBack: () => void;
};

/**
 * Standalone settings view for the single, instance-wide LLM provider/model.
 * dilna keeps one provider/model globally (ADR-0020); historically it came
 * only from `DILNA_PROVIDER`/`DILNA_MODEL` env vars. This form persists an
 * *override* that takes precedence over those env vars from then on (stored
 * in the `llm_config` table and served by `/api/config`), while the env
 * values remain the fallback whenever the override is cleared.
 *
 * Deliberately single-provider/single-model — no per-repo or per-session
 * selection, matching how the agent backend already works.
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

	const hasOverride = Boolean(config?.override);
	const providerHasKey =
		!!config &&
		!!selectedProvider &&
		config.apiKeysConfigured[selectedProvider] === true;

	// Which provider actually runs current sessions (override ?? env).
	const activeProvider = config?.effective.provider || "";
	const usingEnv = !hasOverride && !!config?.envDefault.provider;

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
					<form onSubmit={handleSave} className="space-y-5">
						<div>
							<h2 className="text-lg font-semibold tracking-tight">
								Model provider
							</h2>
							<p className="mt-0.5 text-sm text-muted-foreground">
								dilna runs every session on one provider/model. Pick the one to
								use going forward — this saves an instance-wide override and
								applies to any new session immediately.
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
										{config.apiKeysConfigured[p] ? "" : " (no API key in env)"}
									</option>
								))}
							</select>
							{selectedProvider && !providerHasKey && (
								<p className="text-xs text-muted-foreground">
									No API key is configured in the environment for{" "}
									<span className="font-mono">{selectedProvider}</span> — saving
									will be rejected until one is set.
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
				)}
			</div>
		</div>
	);
}
