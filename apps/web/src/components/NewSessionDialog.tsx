import { useState } from "react";
import { type AgentType, api, type SessionView } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	repoId: string;
	onCreated: (session: SessionView) => void;
};

const AGENT_OPTIONS: {
	value: AgentType;
	label: string;
	description: string;
}[] = [
	{
		value: "opencode",
		label: "opencode",
		description: "opencode serve, spawned per worktree",
	},
	{
		value: "claude",
		label: "Claude",
		description: "Claude Agent SDK (claude-agent-sdk)",
	},
];

export function NewSessionDialog({
	open,
	onOpenChange,
	repoId,
	onCreated,
}: Props) {
	const [agentType, setAgentType] = useState<AgentType>("opencode");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setSubmitting(true);
		setError(null);
		try {
			const { session } = await api.sessions.create(repoId, agentType);
			onOpenChange(false);
			onCreated(session);
		} catch (err) {
			setError(err instanceof Error ? err.message : "session creation failed");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!submitting) onOpenChange(next);
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>New session</DialogTitle>
					<DialogDescription>
						Choose which agent will drive this session.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={handleSubmit} className="space-y-4">
					<div className="space-y-1.5">
						<Label>Agent</Label>
						<div className="flex gap-2">
							{AGENT_OPTIONS.map((opt) => (
								<button
									key={opt.value}
									type="button"
									aria-pressed={agentType === opt.value}
									disabled={submitting}
									onClick={() => setAgentType(opt.value)}
									className={cn(
										"flex-1 rounded-lg border px-3 py-2 text-left text-sm transition-colors disabled:pointer-events-none disabled:opacity-50",
										agentType === opt.value
											? "border-zinc-400 bg-zinc-200 dark:border-zinc-600 dark:bg-zinc-800"
											: "border-border hover:bg-muted",
									)}
								>
									<div className="font-medium">{opt.label}</div>
									<div className="text-xs font-normal text-muted-foreground">
										{opt.description}
									</div>
								</button>
							))}
						</div>
					</div>
					{error && <p className="text-sm text-red-500">{error}</p>}
					<DialogFooter>
						<Button type="submit" disabled={submitting}>
							{submitting ? "Creating…" : "Create"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
