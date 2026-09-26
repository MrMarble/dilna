import { useState } from "react";
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

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCloned: () => void;
};

export function NewRepoDialog({ open, onOpenChange, onCloned }: Props) {
	const [url, setUrl] = useState("");
	const [slug, setSlug] = useState("");
	const [submitting, setSubmitting] = useState<"clone" | "workspace" | null>(
		null,
	);
	const [error, setError] = useState<string | null>(null);

	async function run(
		kind: "clone" | "workspace",
		create: () => Promise<unknown>,
	) {
		setSubmitting(kind);
		setError(null);
		try {
			await create();
			setUrl("");
			setSlug("");
			onOpenChange(false);
			onCloned();
		} catch (err) {
			setError(
				err instanceof Error
					? err.message
					: kind === "clone"
						? "clone failed"
						: "workspace creation failed",
			);
		} finally {
			setSubmitting(null);
		}
	}

	function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!url.trim()) return;
		void run("clone", () =>
			api.repos.clone({
				url: url.trim(),
				slug: slug.trim() || undefined,
			}),
		);
	}

	// A Repo that starts empty, for new work with no existing codebase; the
	// name field is its name, so it's the one input this path requires.
	function handleCreateWorkspace() {
		if (!slug.trim()) return;
		void run("workspace", () =>
			api.repos.createWorkspace({ name: slug.trim() }),
		);
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Clone repository</DialogTitle>
					<DialogDescription>
						Git URL of a public or SSH-reachable private repository — or leave
						it empty and create an empty workspace to start something new.
					</DialogDescription>
				</DialogHeader>
				<form onSubmit={handleSubmit} className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="repo-url">Git URL</Label>
						<Input
							id="repo-url"
							type="text"
							placeholder="git@github.com:owner/repo.git"
							value={url}
							onChange={(e) => setUrl(e.target.value)}
							autoFocus
							disabled={submitting !== null}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="repo-slug">
							Name{" "}
							<span className="text-muted-foreground">
								(optional when cloning, defaults to repo name)
							</span>
						</Label>
						<Input
							id="repo-slug"
							type="text"
							placeholder="my-repo"
							value={slug}
							onChange={(e) => setSlug(e.target.value)}
							disabled={submitting !== null}
						/>
					</div>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={handleCreateWorkspace}
							disabled={submitting !== null || !slug.trim()}
						>
							{submitting === "workspace"
								? "Creating…"
								: "Create empty workspace"}
						</Button>
						<Button type="submit" disabled={submitting !== null || !url.trim()}>
							{submitting === "clone" ? "Cloning…" : "Clone"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
