import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../db";
import {
	ATTACHMENT_MAX_BYTES,
	AttachmentRejectedError,
	attachmentDir,
	attachmentKindFor,
	deleteAttachmentsForSession,
	describeAttachmentsForPrompt,
	describeAttachmentsForTitle,
	getAttachment,
	resolveAttachments,
	sanitizeFilename,
	storeAttachment,
} from "./attachments";

let dataDir: string;
let oldDataDir: string | undefined;

beforeAll(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-attachments-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;
});

afterAll(() => {
	closeDb();
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
});

const bytes = (text: string) => new TextEncoder().encode(text);

describe("attachmentKindFor", () => {
	it.each([
		"image/png",
		"image/jpeg",
		"image/gif",
		"image/webp",
	])("classifies %s as an image", (mime) => {
		expect(attachmentKindFor(mime)).toBe("image");
	});

	it("tolerates a charset parameter and odd casing", () => {
		expect(attachmentKindFor("IMAGE/PNG; charset=binary")).toBe("image");
	});

	// An image type no Provider in dilna's catalog accepts must not be sent
	// down the inline-base64 path, where it becomes a turn-level API error —
	// as a document it still works, the Agent just reads it off disk.
	it.each([
		"image/tiff",
		"image/heic",
		"image/svg+xml",
	])("classifies unsupported image type %s as a document", (mime) => {
		expect(attachmentKindFor(mime)).toBe("document");
	});

	it.each([
		"application/pdf",
		"text/plain",
		"application/octet-stream",
	])("classifies %s as a document", (mime) => {
		expect(attachmentKindFor(mime)).toBe("document");
	});
});

describe("sanitizeFilename", () => {
	it("keeps an ordinary name untouched", () => {
		expect(sanitizeFilename("screenshot.png")).toBe("screenshot.png");
	});

	// The output is concatenated into a filesystem path, so the result must
	// provably contain no separator and no traversal.
	it.each([
		["../../etc/passwd", "etcpasswd"],
		["/etc/passwd", "etcpasswd"],
		["..\\..\\windows\\system32", "windowssystem32"],
		["....//evil.txt", "evil.txt"],
	])("strips traversal and separators from %s", (input, _expected) => {
		const result = sanitizeFilename(input);
		expect(result).not.toContain("/");
		expect(result).not.toContain("\\");
		expect(result.startsWith("..")).toBe(false);
	});

	it("falls back to a placeholder when nothing survives", () => {
		expect(sanitizeFilename("...")).toBe("upload");
		expect(sanitizeFilename("")).toBe("upload");
	});

	it("truncates a very long name but keeps its extension", () => {
		const result = sanitizeFilename(`${"a".repeat(500)}.png`);
		expect(result.length).toBeLessThanOrEqual(120);
		expect(result.endsWith(".png")).toBe(true);
	});
});

describe("storeAttachment", () => {
	it("writes the bytes under the session's directory and records the row", () => {
		const stored = storeAttachment("s-store", {
			filename: "notes.txt",
			mimeType: "text/plain",
			bytes: bytes("hello"),
		});

		expect(stored.kind).toBe("document");
		expect(stored.size).toBe(5);
		expect(readFileSync(stored.path, "utf8")).toBe("hello");
		// The whole point of ADR-0031: never inside a worktree.
		expect(stored.path.startsWith(attachmentDir("s-store"))).toBe(true);
		expect(stored.path).not.toContain("worktrees");
		// The Agent sees a recognizable name on disk, not a bare uuid.
		expect(path.basename(stored.path).endsWith("notes.txt")).toBe(true);

		expect(getAttachment("s-store", stored.id)).toEqual(stored);
	});

	it("keeps two uploads of the same filename separate", () => {
		const first = storeAttachment("s-dup", {
			filename: "same.txt",
			mimeType: "text/plain",
			bytes: bytes("first"),
		});
		const second = storeAttachment("s-dup", {
			filename: "same.txt",
			mimeType: "text/plain",
			bytes: bytes("second"),
		});

		expect(first.path).not.toBe(second.path);
		expect(readFileSync(first.path, "utf8")).toBe("first");
		expect(readFileSync(second.path, "utf8")).toBe("second");
	});

	it("rejects an empty file", () => {
		expect(() =>
			storeAttachment("s-empty", {
				filename: "nothing.txt",
				mimeType: "text/plain",
				bytes: new Uint8Array(0),
			}),
		).toThrow(AttachmentRejectedError);
	});

	it("rejects a file over the size limit", () => {
		expect(() =>
			storeAttachment("s-big", {
				filename: "huge.bin",
				mimeType: "application/octet-stream",
				bytes: new Uint8Array(ATTACHMENT_MAX_BYTES + 1),
			}),
		).toThrow(AttachmentRejectedError);
	});
});

describe("getAttachment", () => {
	it("does not resolve an attachment belonging to another session", () => {
		const stored = storeAttachment("s-owner", {
			filename: "private.txt",
			mimeType: "text/plain",
			bytes: bytes("private"),
		});
		expect(getAttachment("s-intruder", stored.id)).toBeNull();
		expect(getAttachment("s-owner", stored.id)).not.toBeNull();
	});
});

describe("resolveAttachments", () => {
	it("returns the attachments in the order the caller listed them", () => {
		const a = storeAttachment("s-order", {
			filename: "a.txt",
			mimeType: "text/plain",
			bytes: bytes("a"),
		});
		const b = storeAttachment("s-order", {
			filename: "b.txt",
			mimeType: "text/plain",
			bytes: bytes("b"),
		});

		expect(
			resolveAttachments("s-order", [b.id, a.id]).map((x) => x.id),
		).toEqual([b.id, a.id]);
	});

	it("returns empty for no ids", () => {
		expect(resolveAttachments("s-none", [])).toEqual([]);
	});

	// Silently dropping one would send a turn whose message lost a file the
	// user attached — the send must fail loudly so the draft survives.
	it("throws rather than dropping an id from another session", () => {
		const stored = storeAttachment("s-a", {
			filename: "a.txt",
			mimeType: "text/plain",
			bytes: bytes("a"),
		});
		expect(() => resolveAttachments("s-b", [stored.id])).toThrow(
			AttachmentRejectedError,
		);
	});

	it("throws on an unknown id", () => {
		expect(() => resolveAttachments("s-a", ["no-such-id"])).toThrow(
			AttachmentRejectedError,
		);
	});

	it("rejects more attachments than one message may carry", () => {
		expect(() =>
			resolveAttachments("s-many", new Array(11).fill("some-id")),
		).toThrow(AttachmentRejectedError);
	});
});

describe("deleteAttachmentsForSession", () => {
	it("removes both the rows and the bytes on disk", () => {
		const stored = storeAttachment("s-delete", {
			filename: "doomed.txt",
			mimeType: "text/plain",
			bytes: bytes("doomed"),
		});
		expect(existsSync(stored.path)).toBe(true);

		deleteAttachmentsForSession("s-delete");

		expect(getAttachment("s-delete", stored.id)).toBeNull();
		expect(existsSync(stored.path)).toBe(false);
		expect(existsSync(attachmentDir("s-delete"))).toBe(false);
	});

	it("is a no-op for a session with no attachments", () => {
		expect(() => deleteAttachmentsForSession("s-never-used")).not.toThrow();
	});
});

describe("describeAttachmentsForTitle", () => {
	// The regression this exists for: an attachment-only first turn used to
	// hand `generateSessionTitle` an empty string.
	it("names the attachments when the message has no text", () => {
		const image = storeAttachment("s-title", {
			filename: "login-screen.png",
			mimeType: "image/png",
			bytes: bytes("png"),
		});

		const result = describeAttachmentsForTitle("", [image]);

		expect(result).toContain("login-screen.png");
		expect(result.trim().length).toBeGreaterThan(0);
	});

	it("keeps the user's own words first when there are both", () => {
		const doc = storeAttachment("s-title", {
			filename: "spec.pdf",
			mimeType: "application/pdf",
			bytes: bytes("pdf"),
		});

		const result = describeAttachmentsForTitle("review this spec", [doc]);

		expect(result.startsWith("review this spec")).toBe(true);
		expect(result).toContain("spec.pdf");
	});

	// The Agent's preamble carries paths and copy instructions; a 3-4 word
	// title derived from those would be dominated by them.
	it("omits the paths and copy instructions the Agent's preamble carries", () => {
		const image = storeAttachment("s-title", {
			filename: "shot.png",
			mimeType: "image/png",
			bytes: bytes("png"),
		});

		const result = describeAttachmentsForTitle("hi", [image]);

		expect(result).not.toContain(image.path);
		expect(result.toLowerCase()).not.toContain("worktree");
	});

	it("is just the text when there are no attachments", () => {
		expect(describeAttachmentsForTitle("plain message", [])).toBe(
			"plain message",
		);
	});
});

describe("describeAttachmentsForPrompt", () => {
	it("is empty when there are no attachments, so no preamble is prepended", () => {
		expect(describeAttachmentsForPrompt([])).toBe("");
	});

	it("names every attachment's on-disk path, images included", () => {
		const image = storeAttachment("s-prompt", {
			filename: "shot.png",
			mimeType: "image/png",
			bytes: bytes("png"),
		});
		const doc = storeAttachment("s-prompt", {
			filename: "spec.pdf",
			mimeType: "application/pdf",
			bytes: bytes("pdf"),
		});

		const described = describeAttachmentsForPrompt([image, doc]);

		// An image travels inline too, but the Agent still needs its path to
		// act on the file ("crop this and save it").
		expect(described).toContain(image.path);
		expect(described).toContain(doc.path);
		expect(described).toContain("shown to you inline");
		// ADR-0031's usability half: reachable, outside the worktree, and the
		// Agent is told copying it in is the user's call.
		expect(described).toContain("outside the worktree");
		expect(described.toLowerCase()).toContain("copy");
	});
});
