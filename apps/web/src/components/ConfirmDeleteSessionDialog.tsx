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
import {
	Drawer,
	DrawerContent,
	DrawerDescription,
	DrawerTitle,
} from "@/components/ui/drawer";

type Props = {
	/** The Session awaiting confirmation, or null when the dialog is closed. */
	session: SessionView | null;
	onCancel: () => void;
	onConfirm: (id: string) => void;
	/** "dialog" (default) is the centered modal — the desktop pointer idiom.
	 * "sheet" is a bottom action sheet that stacks on the open mobile menu
	 * sheet instead of replacing it: the sheet keeps its scroll position and
	 * expanded repo underneath, so deleting several Sessions in a row doesn't
	 * pay a reopen per delete. */
	variant?: "dialog" | "sheet";
};

/** The stakes, shared verbatim by both variants — the one place that says
 * what deletion actually costs, so the two renderings can't drift apart. */
function DescriptionBody({ title }: { title: string | undefined }) {
	return (
		<>
			<span className="font-medium text-foreground">{title}</span> will be
			deleted with its transcript, worktree and branch — including any
			uncommitted or unpushed work. This can't be undone.
		</>
	);
}

/**
 * Deleting a Session is irreversible (its transcript, worktree and branch go
 * with it), and delete affordances sit next to buttons people tap often —
 * on mobile a revealed swipe tile opens right under where the row was — so
 * a stray click must not be enough. Cancel takes initial focus, so a reflex
 * Enter doesn't confirm either.
 */
export function ConfirmDeleteSessionDialog({
	session,
	onCancel,
	onConfirm,
	variant = "dialog",
}: Props) {
	const cancelRef = useRef<HTMLButtonElement>(null);
	if (variant === "sheet") {
		return (
			<Drawer
				open={session !== null}
				onOpenChange={(open) => {
					if (!open) onCancel();
				}}
			>
				<DrawerContent initialFocus={cancelRef}>
					<div className="flex flex-col gap-3 p-4 pt-1">
						<DrawerTitle>Delete session?</DrawerTitle>
						<DrawerDescription>
							<DescriptionBody title={session?.title} />
						</DrawerDescription>
						<div className="mt-1 flex flex-col gap-2">
							<Button
								variant="destructive"
								onClick={() => session && onConfirm(session.id)}
							>
								Delete
							</Button>
							<Button ref={cancelRef} variant="outline" onClick={onCancel}>
								Cancel
							</Button>
						</div>
					</div>
				</DrawerContent>
			</Drawer>
		);
	}
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
						<DescriptionBody title={session?.title} />
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
