import type { SessionView } from "@dilna/shared";
import { useRef } from "react";
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
	/** The Session awaiting confirmation, or null when the dialog is closed. */
	session: SessionView | null;
	onCancel: () => void;
	onConfirm: (id: string) => void;
};

/**
 * Deleting a Session is irreversible (its transcript, worktree and branch go
 * with it), and the trash icons sit next to buttons people tap often — the
 * mobile sheet's current-Session row opens right under the menu button — so
 * a stray click must not be enough. Cancel takes initial focus, so a reflex
 * Enter doesn't confirm either.
 */
export function ConfirmDeleteSessionDialog({
	session,
	onCancel,
	onConfirm,
}: Props) {
	const cancelRef = useRef<HTMLButtonElement>(null);
	return (
		<Dialog
			open={session !== null}
			onOpenChange={(open) => {
				if (!open) onCancel();
			}}
		>
			<DialogContent initialFocus={cancelRef}>
				<DialogHeader>
					<DialogTitle>Delete session?</DialogTitle>
					<DialogDescription>
						<span className="font-medium text-foreground">
							{session?.title}
						</span>{" "}
						will be deleted with its transcript, worktree and branch — including
						any uncommitted or unpushed work. This can't be undone.
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button ref={cancelRef} variant="outline" onClick={onCancel}>
						Cancel
					</Button>
					<Button
						variant="destructive"
						onClick={() => session && onConfirm(session.id)}
					>
						Delete
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
