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
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		if (!url.trim()) return;
		setSubmitting(true);
		setError(null);
		try {
			await api.repos.clone({
				url: url.trim(),
				slug: slug.trim() || undefined,
			});
			setUrl("");
			setSlug("");
			onOpenChange(false);
			onCloned();
		} catch (err) {
			setError(err instanceof Error ? err.message : "clone failed");
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Clone repository</DialogTitle>
					<DialogDescription>
						Git URL of a public or SSH-reachable private repository.
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
							disabled={submitting}
							required
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="repo-slug">
							Slug{" "}
							<span className="text-muted-foreground">
								(optional, defaults to repo name)
							</span>
						</Label>
						<Input
							id="repo-slug"
							type="text"
							placeholder="my-repo"
							value={slug}
							onChange={(e) => setSlug(e.target.value)}
							disabled={submitting}
						/>
					</div>
					{error && <p className="text-sm text-red-500">{error}</p>}
					<DialogFooter>
						<Button type="submit" disabled={submitting || !url.trim()}>
							{submitting ? "Cloning…" : "Clone"}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
