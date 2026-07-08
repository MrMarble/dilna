import { useState } from "react";
import { api, type SessionView } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	repoId: string;
	onCreated: (session: SessionView) => void;
};

export function NewSessionDialog({
	open,
	onOpenChange,
	repoId,
	onCreated,
}: Props) {
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setSubmitting(true);
		setError(null);
		try {
			const { session } = await api.sessions.create(repoId);
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
						Start a new session on a fresh worktree.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={handleSubmit} className="space-y-4">
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
