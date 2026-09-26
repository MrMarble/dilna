import type { ComparisonView, LlmConfig, Repo } from "@dilna/shared";
import { useEffect, useState } from "react";
import { api } from "@/api/client";
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

/** `repoId` value of the "create a new empty workspace" dropdown option —
 * the same escape hatch the New Repo dialog offers (#256), so a comparison
 * can start from scratch without leaving the modal. Not a valid Repo id. */
const NEW_WORKSPACE = "__workspace__";

const SELECT_CLASS =
	"h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/** A `provider:model` compound select value — split back apart on submit.
 * One select per arm spans every provider, so the option value has to carry
 * both halves (a model id alone is ambiguous across custom providers). */
function parseModelValue(value: string): { provider: string; model: string } {
	const idx = value.indexOf(":");
	return {
		provider: value.slice(0, idx),
		model: value.slice(idx + 1),
	};
}

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	repos: Repo[];
	onCreated: (comparison: ComparisonView) => void;
};

/**
 * The "compare models" modal (issue #250): pick a Repo (or mint a new empty
 * workspace), two models, and the initial prompt — one submit creates the
 * two model-pinned Sessions and fans the prompt out to both. Exactly two
 * arms in v1: the comparison view's side-by-side and pill layouts are built
 * around a pair, and the server schema's cap (MAX_COMPARISON_ARMS) leaves
 * room to widen the picker later without a migration.
 */
export function NewComparisonDialog({
	open,
	onOpenChange,
	repos,
	onCreated,
}: Props) {
	const [repoId, setRepoId] = useState("");
	const [workspaceName, setWorkspaceName] = useState("");
	const [modelA, setModelA] = useState("");
	const [modelB, setModelB] = useState("");
	const [prompt, setPrompt] = useState("");
	const [config, setConfig] = useState<LlmConfig | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// The model lists come from the same /api/config payload the Settings
	// view reads: every provider's catalog plus which providers have keys.
	// Refetched each open so a key added since last time is reflected.
	useEffect(() => {
		if (!open) return;
		setError(null);
		let cancelled = false;
		api.config
			.get()
			.then((config) => {
				if (cancelled) return;
				setConfig(config);
				setModelA((a) => a || firstModelValue(config, 0));
				setModelB((b) => b || firstModelValue(config, 1));
			})
			.catch(() => {
				if (!cancelled) setError("Couldn't load the provider list.");
			});
		return () => {
			cancelled = true;
		};
	}, [open]);

	function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!repoId || !modelA || !modelB || !prompt.trim()) return;
		if (repoId === NEW_WORKSPACE && !workspaceName.trim()) return;
		setSubmitting(true);
		setError(null);
		(async () => {
			try {
				// The workspace option resolves first: the comparison arms hang
				// off the freshly-minted Repo.
				let effectiveRepoId = repoId;
				if (repoId === NEW_WORKSPACE) {
					const { repo } = await api.repos.createWorkspace({
						name: workspaceName.trim(),
					});
					effectiveRepoId = repo.id;
				}
				const { comparison } = await api.comparisons.create({
					repoId: effectiveRepoId,
					prompt: prompt.trim(),
					models: [parseModelValue(modelA), parseModelValue(modelB)],
				});
				setRepoId("");
				setWorkspaceName("");
				setPrompt("");
				onOpenChange(false);
				onCreated(comparison);
			} catch (err) {
				setError(
					err instanceof Error ? err.message : "comparison creation failed",
				);
			} finally {
				setSubmitting(false);
			}
		})();
	}

	const hasModels =
		config !== null && Object.keys(config.modelsByProvider).length > 0;

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Compare models</DialogTitle>
					<DialogDescription>
						Run one prompt against two models at once and read the answers side
						by side. Each arm is an ordinary session on its own worktree.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={handleSubmit} className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="comparison-repo">Repository</Label>
						<select
							id="comparison-repo"
							value={repoId}
							onChange={(e) => setRepoId(e.target.value)}
							required
							className={SELECT_CLASS}
							disabled={submitting}
						>
							<option value="" disabled>
								Select a repository…
							</option>
							{repos.map((r) => (
								<option key={r.id} value={r.id}>
									{r.slug}
								</option>
							))}
							<option value={NEW_WORKSPACE}>+ New empty workspace…</option>
						</select>
					</div>
					{repoId === NEW_WORKSPACE && (
						<div className="space-y-1.5">
							<Label htmlFor="comparison-workspace-name">Workspace name</Label>
							<Input
								id="comparison-workspace-name"
								type="text"
								placeholder="my-workspace"
								value={workspaceName}
								onChange={(e) => setWorkspaceName(e.target.value)}
								autoFocus
								disabled={submitting}
							/>
						</div>
					)}
					<div className="grid grid-cols-2 gap-3">
						<div className="space-y-1.5">
							<Label htmlFor="comparison-model-a">Model A</Label>
							<ModelSelect
								id="comparison-model-a"
								value={modelA}
								onChange={setModelA}
								config={config}
								disabled={submitting}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="comparison-model-b">Model B</Label>
							<ModelSelect
								id="comparison-model-b"
								value={modelB}
								onChange={setModelB}
								config={config}
								disabled={submitting}
							/>
						</div>
					</div>
					{!hasModels && (
						<p className="text-xs text-muted-foreground">
							No models available — add a provider key in Settings first.
						</p>
					)}
					<div className="space-y-1.5">
						<Label htmlFor="comparison-prompt">Initial prompt</Label>
						<textarea
							id="comparison-prompt"
							value={prompt}
							onChange={(e) => setPrompt(e.target.value)}
							required
							rows={4}
							placeholder="What should both models work on?"
							className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
							disabled={submitting}
						/>
					</div>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<DialogFooter>
						<Button
							type="submit"
							disabled={
								submitting ||
								!repoId ||
								!modelA ||
								!modelB ||
								!prompt.trim() ||
								(repoId === NEW_WORKSPACE && !workspaceName.trim())
							}
						>
							{submitting ? "Starting…" : "Start comparison"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}

/** One arm's model picker: every provider's catalog as optgroups, keyed
 * providers first. An option whose provider has no key still renders (with a
 * suffix, matching Settings) — the server rejects the pair with a clear
 * error rather than the select hiding it. */
function ModelSelect({
	id,
	value,
	onChange,
	config,
	disabled,
}: {
	id: string;
	value: string;
	onChange: (value: string) => void;
	config: LlmConfig | null;
	disabled: boolean;
}) {
	const entries = Object.entries(config?.modelsByProvider ?? {});
	const keyed = entries.filter(([p]) => config?.apiKeysConfigured[p]);
	const unkeyed = entries.filter(([p]) => !config?.apiKeysConfigured[p]);

	return (
		<select
			id={id}
			value={value}
			onChange={(e) => onChange(e.target.value)}
			required
			className={cn(SELECT_CLASS, "font-mono")}
			disabled={disabled || entries.length === 0}
		>
			<option value="" disabled>
				Select a model…
			</option>
			{[...keyed, ...unkeyed].map(([provider, models]) => (
				<optgroup
					key={provider}
					label={
						config?.apiKeysConfigured[provider]
							? provider
							: `${provider} (no API key)`
					}
				>
					{models.map((m) => (
						<option key={`${provider}:${m.id}`} value={`${provider}:${m.id}`}>
							{m.name || m.id}
						</option>
					))}
				</optgroup>
			))}
		</select>
	);
}

/** The `provider:model` value to prefill an arm with: the nth distinct
 * provider's first model, so a fresh dialog suggests two different providers
 * when the instance has them (the headline cross-provider case). */
function firstModelValue(config: LlmConfig, n: number): string {
	const keyed = Object.entries(config.apiKeysConfigured)
		.filter(([, hasKey]) => hasKey)
		.map(([provider]) => provider);
	const providers =
		keyed.length > 0 ? keyed : Object.keys(config.modelsByProvider);
	const provider = providers[n % Math.max(providers.length, 1)];
	const model = provider ? config.modelsByProvider[provider]?.[0] : undefined;
	return provider && model ? `${provider}:${model.id}` : "";
}
