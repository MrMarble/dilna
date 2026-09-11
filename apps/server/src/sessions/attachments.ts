import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Attachment, AttachmentKind } from "@dilna/shared";
import { and, eq, inArray } from "drizzle-orm";
import { getDataDir, getDb } from "../db";
import { attachments as attachmentsTable } from "../db/schema";

/**
 * Everything dilna does with an uploaded file (issue #53, ADR-0031): where
 * the bytes land, what a filename is allowed to be, which files a Provider
 * can see as pixels, and how a Session's uploads are handed to its Agent.
 *
 * The module boundary is "a file the user sent", start to finish — accepting
 * bytes, storing them, and describing them — so no caller ever assembles an
 * attachment path itself. The route validates nothing about files; the
 * Agent adapter derives nothing about kinds. Both call in here.
 *
 * **Storage is deliberately outside every Worktree** (ADR-0031):
 * `<DILNA_DATA_DIR>/attachments/<sessionId>/`. An upload is a chat artifact,
 * not a source change — landing one inside a Worktree would make it show up
 * in `git status`, in the Session's diff view, and eventually in a commit
 * the user never asked for. The Agent is granted *read* access to this
 * directory (see `agents/confinement.ts` and `agents/worktreeSandbox.ts`),
 * so "copy that screenshot into `docs/`" is a thing the user can ask for and
 * the Agent can do — an explicit act, rather than the default.
 */

/**
 * Hard cap per uploaded file. Sized for the actual use case (screenshots,
 * PDFs, logs) rather than the transport's limits: an image attachment is
 * re-encoded as base64 straight into the prompt, so a large one is charged
 * against the Session's context window at roughly 4/3 its byte size, and a
 * single oversized upload can cost more context than the conversation it was
 * attached to. Enforced here, the one write path, rather than in the route's
 * schema, so the bound can't drift between validation and storage.
 *
 * Deliberately under `index.ts`'s global 5MB `bodyLimit`, leaving room for
 * multipart framing: a file over *this* bound gets a 413 naming the limit,
 * whereas one over the body limit is cut off by middleware before the route
 * can say anything useful. Raise that one first if this ever grows.
 */
export const ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;

/** Hard cap on how many files one message may carry. Bounds both the prompt
 * preamble {@link describeAttachmentsForPrompt} builds and the number of
 * base64 images a single turn can inline. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/**
 * MIME types dilna sends to a Provider as actual image content. Restricted
 * to the four every vision-capable Provider in dilna's catalog accepts —
 * deliberately *not* "anything `image/*`", because an unsupported image type
 * (`image/tiff`, `image/heic`) reaching the Provider is a turn-level API
 * error, whereas classifying it as a document degrades to "the Agent can
 * read the file off disk", which still works.
 */
const IMAGE_MIME_TYPES = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);

/**
 * Which channel a file takes to the Agent, decided once at upload time from
 * the MIME type the browser reported.
 *
 * `"image"` means the bytes travel inline in the prompt as base64 and the
 * Provider sees the picture. `"document"` means the Agent is told the path
 * and reads it with its own tools. The fallback is `"document"` precisely
 * because it's the one that can't fail at the Provider: every file is
 * readable off disk, only some are viewable.
 */
export function attachmentKindFor(mimeType: string): AttachmentKind {
	return IMAGE_MIME_TYPES.has(
		mimeType.toLowerCase().split(";")[0]?.trim() ?? "",
	)
		? "image"
		: "document";
}

/**
 * Reduce a user-supplied filename to something safe to use as a path
 * component, preserving enough of the original that the Agent (and the user
 * asking it to "look at the screenshot") sees a recognizable name.
 *
 * Strips directory separators and traversal outright rather than escaping
 * them: the input is an untrusted browser-supplied string and the output is
 * concatenated into a filesystem path, so the only safe transformation is
 * one whose result provably contains no separator. `path.basename` alone is
 * not enough — it's platform-dependent (a `\` is a separator on Windows, a
 * literal character on Linux) and leaves `..` intact.
 */
export function sanitizeFilename(filename: string): string {
	const stripped = Array.from(filename)
		// Control characters (including NUL, which truncates a path in many C
		// APIs) are dropped by code point rather than by a regex range — same
		// result, without embedding literal control chars in a pattern.
		.filter((ch) => {
			const code = ch.codePointAt(0) ?? 0;
			return code > 0x1f && code !== 0x7f;
		})
		.join("")
		.replace(/[/\\]/g, "_")
		.replace(/^\.+/, "")
		.trim();
	// Long names are truncated from the *front* of the extension so the
	// suffix survives — the extension is what tells the Agent (and any tool
	// it runs) how to read the file.
	const ext = path.extname(stripped).slice(0, 16);
	const stem = path.basename(stripped, path.extname(stripped)).slice(0, 100);
	const safe = `${stem}${ext}`;
	return safe.length > 0 ? safe : "upload";
}

/** The directory one Session's uploads live in. Outside every Worktree by
 * construction — see the module doc comment and ADR-0031. Derived from
 * {@link getDataDir} per call, never memoized, so a test (or an isolated
 * instance) pointing `DILNA_DATA_DIR` elsewhere is honoured. */
export function attachmentDir(sessionId: string): string {
	return path.join(getDataDir(), "attachments", sessionId);
}

/** Thrown by {@link storeAttachment} when the upload breaks a documented
 * bound. Distinguished from an unexpected failure so the route can answer
 * 413/400 rather than 500. */
export class AttachmentRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AttachmentRejectedError";
	}
}

/**
 * Accept one uploaded file: validate it, write the bytes under the Session's
 * attachment directory, and record the row. Returns the {@link Attachment}
 * the client references in its subsequent send.
 *
 * The on-disk name is `<short-hash>-<sanitized filename>`, not the id: the
 * Agent is shown this path in its prompt and reads it with its own tools, so
 * a name it can recognize ("login-screenshot.png") is worth more than one
 * that matches the database key. The hash prefix — derived from the id, so
 * it needs no collision retry — keeps two uploads of the same filename from
 * clobbering each other within one Session.
 */
export function storeAttachment(
	sessionId: string,
	file: { filename: string; mimeType: string; bytes: Uint8Array },
): Attachment {
	if (file.bytes.byteLength === 0) {
		throw new AttachmentRejectedError("file is empty");
	}
	if (file.bytes.byteLength > ATTACHMENT_MAX_BYTES) {
		throw new AttachmentRejectedError(
			`file exceeds the ${Math.floor(ATTACHMENT_MAX_BYTES / (1024 * 1024))}MB limit`,
		);
	}

	const id = randomUUID();
	const filename = sanitizeFilename(file.filename);
	const dir = attachmentDir(sessionId);
	mkdirSync(dir, { recursive: true });
	const prefix = createHash("sha256").update(id).digest("hex").slice(0, 8);
	const diskPath = path.join(dir, `${prefix}-${filename}`);
	writeFileSync(diskPath, file.bytes);

	const attachment: Attachment = {
		id,
		sessionId,
		filename,
		mimeType: file.mimeType,
		size: file.bytes.byteLength,
		kind: attachmentKindFor(file.mimeType),
		path: diskPath,
		createdAt: Math.floor(Date.now() / 1000),
	};
	getDb().insert(attachmentsTable).values(attachment).run();
	return attachment;
}

/** One attachment, scoped to its owning Session. The `sessionId` filter is
 * not an optimization: an attachment id is only meaningful within its
 * Session, so a lookup that ignored it would let one Session reference
 * another's files. */
export function getAttachment(
	sessionId: string,
	attachmentId: string,
): Attachment | null {
	const row = getDb()
		.select()
		.from(attachmentsTable)
		.where(
			and(
				eq(attachmentsTable.sessionId, sessionId),
				eq(attachmentsTable.id, attachmentId),
			),
		)
		.get();
	return row ? rowToAttachment(row) : null;
}

/**
 * Resolve the ids a send referenced, in the order the client listed them.
 *
 * Throws on the first id that doesn't resolve within this Session rather
 * than silently dropping it: the user attached a file and expects the Agent
 * to see it, so a send that would quietly lose one must fail loudly enough
 * for the composer to keep the draft (see `routes/sessions.ts`'s 400).
 */
export function resolveAttachments(
	sessionId: string,
	attachmentIds: string[],
): Attachment[] {
	if (attachmentIds.length === 0) return [];
	if (attachmentIds.length > MAX_ATTACHMENTS_PER_MESSAGE) {
		throw new AttachmentRejectedError(
			`a message may carry at most ${MAX_ATTACHMENTS_PER_MESSAGE} attachments`,
		);
	}
	const rows = getDb()
		.select()
		.from(attachmentsTable)
		.where(
			and(
				eq(attachmentsTable.sessionId, sessionId),
				inArray(attachmentsTable.id, attachmentIds),
			),
		)
		.all();
	const byId = new Map(rows.map((row) => [row.id, rowToAttachment(row)]));
	return attachmentIds.map((id) => {
		const found = byId.get(id);
		if (!found) {
			throw new AttachmentRejectedError(
				`attachment ${id} does not belong to this session`,
			);
		}
		return found;
	});
}

/** Drop a Session's attachment rows and the directory holding their bytes.
 * Called from `SessionManager.delete`, which is the only thing that prunes
 * attachments at all — an upload the user never sent keeps its row until
 * then (see the schema's table comment). */
export function deleteAttachmentsForSession(sessionId: string): void {
	getDb()
		.delete(attachmentsTable)
		.where(eq(attachmentsTable.sessionId, sessionId))
		.run();
	const dir = attachmentDir(sessionId);
	if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

/**
 * The prompt preamble that tells the Agent what the user attached and where
 * to find it — prepended to the user's own text by `SessionManager.runTurn`.
 *
 * Every attachment is listed with its absolute path, images included: an
 * image also travels inline as base64 (so the Provider can see it), but the
 * Agent still needs the path to act on the file — "crop this and save it to
 * `assets/`" is a filesystem operation, and the model cannot write back the
 * pixels it was shown.
 *
 * The note about copying is what makes ADR-0031's storage choice usable
 * rather than merely safe: the file is reachable but outside the Worktree,
 * and the Agent has to be told that moving it in is both possible and the
 * user's call.
 */
export function describeAttachmentsForPrompt(
	attachments: Attachment[],
): string {
	if (attachments.length === 0) return "";
	const lines = attachments.map((a) => {
		const shown = a.kind === "image" ? " (shown to you inline)" : "";
		return `- ${a.filename} — ${a.mimeType}, ${formatBytes(a.size)}${shown}\n  ${a.path}`;
	});
	return [
		attachments.length === 1
			? "The user attached a file to this message:"
			: `The user attached ${attachments.length} files to this message:`,
		...lines,
		"",
		"These paths are readable but sit outside the worktree, so nothing here is part of the repo. Copy a file into the worktree only if the user asks you to.",
	].join("\n");
}

function formatBytes(size: number): string {
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
	return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function rowToAttachment(
	row: typeof attachmentsTable.$inferSelect,
): Attachment {
	return {
		id: row.id,
		sessionId: row.sessionId,
		filename: row.filename,
		mimeType: row.mimeType,
		size: row.size,
		kind: row.kind as AttachmentKind,
		path: row.path,
		createdAt: row.createdAt,
	};
}
