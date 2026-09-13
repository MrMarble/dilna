import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import {
	ARTEFACT_MAX_BYTES,
	type Artefact,
	type ArtefactKind,
} from "@dilna/shared";
import { and, desc, eq } from "drizzle-orm";
import { isContained } from "../agents/confinement";
import { getDataDir, getDb } from "../db";
import { artefacts as artefactsTable } from "../db/schema";

/**
 * Everything dilna does with a file an Agent **publishes** (issue #194,
 * ADR-0032): which files are publishable, where the copy lands, and how one
 * is looked up again.
 *
 * The module boundary is "a file the Agent produced for the user", start to
 * finish — so no caller assembles an artefact path itself. The tool
 * validates nothing about files and the route derives nothing about kinds;
 * both call in here. This mirrors `attachments.ts` deliberately: an
 * Attachment travels user→Agent, an Artefact travels Agent→user, and the two
 * are the same problem in opposite directions.
 *
 * **The bytes are copied, not referenced** (ADR-0032):
 * `<DILNA_DATA_DIR>/artefacts/<sessionId>/`, outside every Worktree. A
 * reference into the Worktree would 404 the moment the next turn checked out
 * another branch or the Session was deleted — and a report whose link rots is
 * not a result. Copying also makes an Artefact immutable, which is what lets
 * two publishes of the same report be compared rather than one silently
 * replacing the other.
 */

/**
 * MIME type per publishable extension — and, by being the only source of
 * truth for what's publishable at all, the enforcement point for ADR-0032's
 * HTML-only v1 scope.
 *
 * Narrow on purpose: an Artefact that the UI cannot render is worse than a
 * refused publish, because the failure surfaces to the user as an empty
 * panel row long after the turn that produced it. Widening this map is the
 * whole of "support another artefact type" server-side — but see ADR-0032's
 * CSP note before adding anything that executes.
 */
const PUBLISHABLE: Record<string, { kind: ArtefactKind; mimeType: string }> = {
	".html": { kind: "html", mimeType: "text/html; charset=utf-8" },
	".htm": { kind: "html", mimeType: "text/html; charset=utf-8" },
};

/** Human-readable list for error messages, so a rejection tells the Agent
 * what *would* work instead of only what didn't. */
const PUBLISHABLE_EXTENSIONS = Object.keys(PUBLISHABLE).join(", ");

/** Thrown when a publish breaks a documented bound (missing file, wrong
 * type, too big, outside the Worktree). Distinguished from an unexpected
 * failure so the tool can answer with a message the Agent can act on rather
 * than an opaque error. */
/**
 * The stored row: an {@link Artefact} plus the on-disk location of the
 * published copy.
 *
 * `path` is deliberately *not* on the shared `Artefact` (unlike
 * `Attachment.path`, which exists so the Agent can be told where an upload
 * is). Nothing outside this module needs it: the Agent publishes *from* the
 * Worktree and never reads the copy back, and the browser fetches bytes by
 * URL. Keeping it server-side means the UI cannot accidentally render a host
 * filesystem path, and the serve route has one way to locate bytes.
 */
type ArtefactRow = Artefact & { path: string };

/** Widen a stored row to {@link ArtefactRow}. Mapped field by field (rather
 * than cast wholesale) for the same reason `rowToAttachment` is: `kind` is a
 * `text` column, so the narrowing to {@link ArtefactKind} is an assertion
 * that has to be made explicitly somewhere, and doing it here keeps it to one
 * place. */
function toRow(row: typeof artefactsTable.$inferSelect): ArtefactRow {
	return {
		id: row.id,
		sessionId: row.sessionId,
		title: row.title,
		filename: row.filename,
		sourcePath: row.sourcePath,
		kind: row.kind as ArtefactKind,
		mimeType: row.mimeType,
		size: row.size,
		path: row.path,
		createdAt: row.createdAt,
	};
}

/** Drop the server-only column on the way out. */
function rowToArtefact(row: ArtefactRow): Artefact {
	const { path: _path, ...artefact } = row;
	return artefact;
}

export class ArtefactRejectedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ArtefactRejectedError";
	}
}

/** The directory one Session's published artefacts live in. Outside every
 * Worktree by construction. Derived from {@link getDataDir} per call, never
 * memoized, so a test (or an isolated instance) pointing `DILNA_DATA_DIR`
 * elsewhere is honoured — same contract as `attachmentDir`. */
export function artefactDir(sessionId: string): string {
	return path.join(getDataDir(), "artefacts", sessionId);
}

/**
 * Reduce a filename to something safe as a path component. Same reasoning as
 * `attachments.ts`'s `sanitizeFilename`: the input is untrusted (here it
 * originates in model output rather than a browser) and the output is
 * concatenated into a filesystem path, so separators and traversal are
 * stripped outright rather than escaped.
 */
function sanitizeFilename(filename: string): string {
	const stripped = Array.from(filename)
		.filter((ch) => {
			const code = ch.codePointAt(0) ?? 0;
			return code > 0x1f && code !== 0x7f;
		})
		.join("")
		.replace(/[/\\]/g, "_")
		.replace(/^\.+/, "")
		.trim();
	const ext = path.extname(stripped).slice(0, 16);
	const stem = path.basename(stripped, path.extname(stripped)).slice(0, 100);
	const safe = `${stem}${ext}`;
	return safe.length > 0 ? safe : "artefact";
}

/** Collapse whitespace and bound a model-supplied title, which is free text
 * and lands directly in the panel's list. */
function sanitizeTitle(title: string): string {
	return title.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Publish one file out of a Session's Worktree: validate it, copy the bytes
 * into the Session's artefact directory, and record the row.
 *
 * `sourcePath` is interpreted relative to the Worktree root (an absolute
 * path inside the Worktree is accepted too, since that's what the Agent's
 * own tools hand back). Containment is checked with the same
 * symlink-resolving {@link isContained} the tool-confinement hook uses —
 * not a lexical prefix comparison, which a symlink planted in the Worktree
 * would defeat. Without this, `dilna_publish_artefact` would be an arbitrary
 * file-read primitive that copies any host file into a URL the browser can
 * fetch.
 *
 * The on-disk name is `<short-hash>-<sanitized filename>`: the hash prefix
 * is derived from the id (so it needs no collision retry) and keeps two
 * publishes of the same report from clobbering each other — which is exactly
 * what makes successive versions comparable.
 */
export function publishArtefact(args: {
	sessionId: string;
	worktreePath: string;
	sourcePath: string;
	title?: string;
}): Artefact {
	const { sessionId, worktreePath, sourcePath } = args;

	const trimmed = sourcePath.trim();
	if (!trimmed) throw new ArtefactRejectedError("path is required");

	const absolute = path.isAbsolute(trimmed)
		? trimmed
		: path.resolve(worktreePath, trimmed);

	if (!isContained(absolute, worktreePath)) {
		throw new ArtefactRejectedError(
			"path must be inside this session's worktree",
		);
	}

	let stat: ReturnType<typeof statSync>;
	try {
		stat = statSync(absolute);
	} catch {
		throw new ArtefactRejectedError(`no such file: ${trimmed}`);
	}
	if (!stat.isFile()) {
		throw new ArtefactRejectedError(`not a file: ${trimmed}`);
	}
	if (stat.size === 0) {
		throw new ArtefactRejectedError(`file is empty: ${trimmed}`);
	}
	if (stat.size > ARTEFACT_MAX_BYTES) {
		throw new ArtefactRejectedError(
			`file exceeds the ${Math.floor(ARTEFACT_MAX_BYTES / (1024 * 1024))}MB artefact limit`,
		);
	}

	const type = PUBLISHABLE[path.extname(absolute).toLowerCase()];
	if (!type) {
		throw new ArtefactRejectedError(
			`only ${PUBLISHABLE_EXTENSIONS} files can be published today`,
		);
	}

	const id = randomUUID();
	const filename = sanitizeFilename(path.basename(absolute));
	const dir = artefactDir(sessionId);
	mkdirSync(dir, { recursive: true });
	const prefix = createHash("sha256").update(id).digest("hex").slice(0, 8);
	const diskPath = path.join(dir, `${prefix}-${filename}`);
	copyFileSync(absolute, diskPath);

	const row: ArtefactRow = {
		id,
		sessionId,
		title: sanitizeTitle(args.title ?? "") || filename,
		filename,
		// Recorded relative to the Worktree: an absolute host path is noise to
		// the user and leaks the server's directory layout into the UI.
		sourcePath: path.relative(worktreePath, absolute) || filename,
		kind: type.kind,
		mimeType: type.mimeType,
		// The copy's size, read back from the copy rather than reused from the
		// source's stat, so the row always describes the bytes actually served.
		size: statSync(diskPath).size,
		path: diskPath,
		createdAt: Math.floor(Date.now() / 1000),
	};
	getDb().insert(artefactsTable).values(row).run();
	return rowToArtefact(row);
}

/** One artefact as its stored {@link ArtefactRow}, i.e. including the
 * server-only `path` — this is the serve route's lookup, and locating the
 * bytes is the point.
 *
 * The `sessionId` filter is not an optimization: it's what keeps one Session
 * from serving another's files (same containment argument as
 * `getAttachment`). */
export function getArtefact(
	sessionId: string,
	artefactId: string,
): ArtefactRow | null {
	const row = getDb()
		.select()
		.from(artefactsTable)
		.where(
			and(
				eq(artefactsTable.sessionId, sessionId),
				eq(artefactsTable.id, artefactId),
			),
		)
		.get();
	return row ? toRow(row) : null;
}

/** A Session's artefacts, newest first — the context panel's list. Newest
 * first because the interesting one is almost always the most recent
 * regeneration, with older versions kept below for comparison. */
export function listArtefacts(sessionId: string): Artefact[] {
	return getDb()
		.select()
		.from(artefactsTable)
		.where(eq(artefactsTable.sessionId, sessionId))
		.orderBy(desc(artefactsTable.createdAt))
		.all()
		.map((row) => rowToArtefact(toRow(row)));
}

/** Drop a Session's artefact rows and the directory holding their bytes.
 * Called from `SessionManager.delete`, the only thing that prunes artefacts
 * at all (see the schema's table comment). */
export function deleteArtefactsForSession(sessionId: string): void {
	getDb()
		.delete(artefactsTable)
		.where(eq(artefactsTable.sessionId, sessionId))
		.run();
	const dir = artefactDir(sessionId);
	if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
