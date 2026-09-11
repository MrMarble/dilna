import type { Attachment } from "@dilna/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";

/**
 * The composer's file tray (issue #53): files the user has picked but not
 * yet sent, each uploading independently in the background.
 *
 * Uploading eagerly on selection — rather than at send time — is what makes
 * the composer feel immediate on a phone: by the time a message is written,
 * the bytes are usually already on the server, and the send itself stays the
 * small JSON POST whose 409 semantics the turn protocol depends on (ADR-0016
 * §2). It also means a failed upload costs nothing: the draft is untouched,
 * no turn was claimed, and the user can drop the one bad file and carry on.
 *
 * The tray is keyed by a client-minted `localId`, not the server's
 * attachment id, because an entry exists (and must be removable) before any
 * server id is known — and a failed upload never gets one at all.
 */

/** Ceiling on tray size, mirroring the server's own per-message bound
 * (`MAX_ATTACHMENTS_PER_MESSAGE`). Enforced client-side too so the user is
 * stopped at the picker rather than at a rejected send. */
export const MAX_ATTACHMENTS = 10;

export type PendingAttachment = {
	/** Client-minted, stable for the entry's whole life — see the module
	 * comment for why the server's id can't serve as the key. */
	localId: string;
	filename: string;
	size: number;
	mimeType: string;
	/** Object URL for an image's local preview, so the tray shows the picture
	 * before (and without) a round trip to the server. Revoked when the entry
	 * leaves the tray; undefined for non-images. */
	previewUrl?: string;
	status: "uploading" | "done" | "error";
	/** The server's record, once the upload lands. This is what the send
	 * references by id. */
	attachment?: Attachment;
	error?: string;
};

export function usePendingAttachments(sessionId: string) {
	const [pending, setPending] = useState<PendingAttachment[]>([]);

	// Object URLs are a manual-lifetime resource: the browser holds the blob
	// alive until revoked. Tracked in a ref (not derived from `pending`) so
	// unmount can revoke every URL that ever existed, including entries
	// already removed from state.
	const objectUrls = useRef<Set<string>>(new Set());
	useEffect(() => {
		const urls = objectUrls.current;
		return () => {
			for (const url of urls) URL.revokeObjectURL(url);
			urls.clear();
		};
	}, []);

	// Mirrors `pending.length` for the cap check in `addFiles`, which runs
	// outside any state updater and so can't read `prev` (see its comment).
	const pendingCount = useRef(0);
	useEffect(() => {
		pendingCount.current = pending.length;
	}, [pending.length]);

	const removePending = useCallback((localId: string) => {
		setPending((prev) => {
			const target = prev.find((p) => p.localId === localId);
			if (target?.previewUrl) {
				URL.revokeObjectURL(target.previewUrl);
				objectUrls.current.delete(target.previewUrl);
			}
			const next = prev.filter((p) => p.localId !== localId);
			pendingCount.current = next.length;
			return next;
		});
	}, []);

	/** Add files to the tray and start uploading them, one request each and
	 * all concurrently — a slow large file never blocks a small one, and each
	 * lands in the tray independently. Silently truncates to
	 * {@link MAX_ATTACHMENTS}; the Plus button is already disabled at the cap,
	 * so this only catches a multi-select that overshoots it. */
	const addFiles = useCallback(
		async (files: FileList | File[] | null) => {
			const list = Array.from(files ?? []);
			if (list.length === 0) return;

			// Built *outside* the `setPending` updater below, deliberately: a
			// state updater is not guaranteed to run synchronously (and runs
			// twice under StrictMode), so computing `accepted` inside one and
			// reading it after would start zero uploads while still rendering the
			// tray entries — every file stuck on "Uploading…" forever. The cap is
			// therefore checked against a ref that tracks the current length,
			// since `prev` isn't available out here.
			const room = Math.max(0, MAX_ATTACHMENTS - pendingCount.current);
			if (room === 0) return;
			const accepted = list.slice(0, room).map((file) => {
				const isImage = file.type.startsWith("image/");
				const previewUrl = isImage ? URL.createObjectURL(file) : undefined;
				if (previewUrl) objectUrls.current.add(previewUrl);
				return {
					file,
					entry: {
						localId: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
						filename: file.name,
						size: file.size,
						mimeType: file.type,
						previewUrl,
						status: "uploading" as const,
					} satisfies PendingAttachment,
				};
			});
			pendingCount.current += accepted.length;
			setPending((prev) => [...prev, ...accepted.map((a) => a.entry)]);

			await Promise.all(
				accepted.map(async ({ file, entry }) => {
					try {
						const attachment = await api.sessions.uploadAttachment(
							sessionId,
							file,
						);
						setPending((prev) =>
							prev.map((p) =>
								p.localId === entry.localId
									? { ...p, status: "done", attachment }
									: p,
							),
						);
					} catch (err) {
						// Kept in the tray as an error rather than dropped: the user
						// picked this file deliberately, and a vanishing row reads as
						// the app losing it. They dismiss it themselves.
						setPending((prev) =>
							prev.map((p) =>
								p.localId === entry.localId
									? {
											...p,
											status: "error",
											error:
												err instanceof Error ? err.message : "upload failed",
										}
									: p,
							),
						);
					}
				}),
			);
		},
		[sessionId],
	);

	/** Empty the tray, revoking every preview URL it held. Called once a send
	 * has been accepted — the files now live in the sent message. */
	const clearPending = useCallback(() => {
		pendingCount.current = 0;
		setPending((prev) => {
			for (const p of prev) {
				if (p.previewUrl) {
					URL.revokeObjectURL(p.previewUrl);
					objectUrls.current.delete(p.previewUrl);
				}
			}
			return [];
		});
	}, []);

	// Switching sessions must not carry one session's tray into another: the
	// ids are scoped per-Session server-side, so a stale entry would fail the
	// send outright.
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed intentionally on sessionId alone — `clearPending` is stable and re-running on its identity would be a no-op.
	useEffect(() => {
		clearPending();
	}, [sessionId]);

	return { pending, addFiles, removePending, clearPending };
}
