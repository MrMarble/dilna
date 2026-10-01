import { MODEL_ROLES, type ModelRole } from "@dilna/shared";
import { RotateCcw, Save } from "lucide-react";
import { useState } from "react";
import { api, type LlmConfig } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/** What each role is for, in the user's terms. Exhaustive over `ModelRole`,
 * so a new role has to be described here before it type-checks. */
const ROLE_COPY: Record<ModelRole, { label: string; description: string }> = {
	cheap: {
		label: "Cheap model",
		description:
			"Used for mechanical work where good-enough beats perfect — titles, summaries, scoring, bulk exploration. Leave unset to keep everything on each Session's own model.",
	},
};

type Props = {
	config: LlmConfig;
	/** Called with the freshly re-read config after a successful write. */
	onConfigChange: (config: LlmConfig) => void;
};

/**
 * Settings' "Model roles" section (issue #308, ADR-0053 §1): one row per
 * role, each pointing at a provider/model pair from the same flat
 * `provider/model` list the Model form uses. This is the only place the
 * concrete model behind a role is shown — prompts and tool descriptions name
 * the role, never the model.
 */
export function ModelRolesSection({ config, onConfigChange }: Props) {
	return (
		<div className="space-y-3 border-t border-border pt-4">
			<div>
				<h2 className="text-lg font-semibold tracking-tight">Model roles</h2>
				<p className="mt-0.5 text-xs text-muted-foreground">
					Named slots the rest of dilna can route work to without knowing which
					model fills them. Changes apply to the next call that uses the role.
				</p>
			</div>
			{MODEL_ROLES.map((role) => (
				<ModelRoleRow
					key={role}
					role={role}
					config={config}
					onConfigChange={onConfigChange}
				/>
			))}
		</div>
	);
}

function ModelRoleRow({
	role,
	config,
	onConfigChange,
}: Props & { role: ModelRole }) {
	const assigned = config.roles?.[role] ?? null;
	const assignedKey = assigned ? `${assigned.provider}/${assigned.model}` : "";
	const [selected, setSelected] = useState(assignedKey);
	const [pending, setPending] = useState<"save" | "clear" | null>(null);
	const [message, setMessage] = useState<{
		kind: "ok" | "error";
		text: string;
	} | null>(null);

	// Same flat keyed list as the Model form: every provider with a key, each
	// option `provider/model` (split on the first `/` — provider ids never
	// contain one, model ids may).
	const options = Object.entries(config.modelsByProvider)
		.filter(([p]) => config.apiKeysConfigured[p])
		.flatMap(([p, models]) =>
			models.map((m) => ({ value: `${p}/${m.id}`, name: m.name })),
		);
	if (assignedKey && !options.some((o) => o.value === assignedKey)) {
		options.unshift({
			value: assignedKey,
			name: `${assignedKey} (no API key)`,
		});
	}

	const copy = ROLE_COPY[role];
	const selectId = `settings-role-${role}`;

	async function write(action: "save" | "clear") {
		setPending(action);
		setMessage(null);
		try {
			if (action === "save") {
				const slash = selected.indexOf("/");
				await api.config.setModelRole(
					role,
					selected.slice(0, slash),
					selected.slice(slash + 1),
				);
			} else {
				await api.config.clearModelRole(role);
				setSelected("");
			}
			onConfigChange(await api.config.get());
			setMessage({
				kind: "ok",
				text:
					action === "save"
						? `Saved — the ${copy.label.toLowerCase()} is now ${selected}.`
						: `Cleared — work routed to the ${copy.label.toLowerCase()} falls back to each Session's own model.`,
			});
		} catch (err) {
			setMessage({
				kind: "error",
				text: err instanceof Error ? err.message : "failed to save role",
			});
		} finally {
			setPending(null);
		}
	}

	return (
		<div className="space-y-1.5 rounded-xl border border-border bg-card p-3 shadow-card">
			<Label htmlFor={selectId}>{copy.label}</Label>
			<p className="text-xs text-muted-foreground">{copy.description}</p>
			<select
				id={selectId}
				value={selected}
				onChange={(e) => setSelected(e.target.value)}
				disabled={options.length === 0}
				className="h-9 w-full rounded-md border border-input bg-transparent px-3 font-mono text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
			>
				<option value="">Not set</option>
				{options.map((o) => (
					<option key={o.value} value={o.value} title={o.name}>
						{o.value}
					</option>
				))}
			</select>
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
				<Button
					type="button"
					onClick={() => void write("save")}
					disabled={pending !== null || !selected || selected === assignedKey}
				>
					<Save className="mr-1.5 size-4" />
					{pending === "save" ? "Saving…" : "Save role"}
				</Button>
				<Button
					type="button"
					variant="outline"
					onClick={() => void write("clear")}
					disabled={pending !== null || !assigned}
					title={
						assigned
							? `Unset the ${copy.label.toLowerCase()}`
							: "Not set — nothing to clear"
					}
				>
					<RotateCcw className="mr-1.5 size-4" />
					{pending === "clear" ? "Clearing…" : "Clear"}
				</Button>
			</div>
		</div>
	);
}
