import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../db";
import {
	ATTACHMENT_MAX_BYTES,
	AttachmentRejectedError,
	attachmentDir,
	getAttachment,
	sendImage,
	sniffImageMimeType,
	storeAttachment,
} from "./attachments";

/**
 * The Agent→user half of the attachment surface (issue #222, ADR-0038).
 *
 * The containment and sniffing cases are the security-relevant ones: without
 * them `dilna_send_image` is an arbitrary file-read primitive that copies any
 * host file onto a URL the browser fetches from dilna's own origin.
 */

let dataDir: string;
let worktree: string;
let outside: string;
let oldDataDir: string | undefined;

/** Smallest bytes that are unambiguously each format to a magic-byte sniff. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const GIF = Buffer.from("GIF89a________", "latin1");
const WEBP = Buffer.concat([
	Buffer.from("RIFF", "latin1"),
	Buffer.from([0, 0, 0, 0]),
	Buffer.from("WEBP", "latin1"),
]);

beforeAll(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-sendimage-"));
	worktree = mkdtempSync(path.join(tmpdir(), "dilna-test-worktree-"));
	outside = mkdtempSync(path.join(tmpdir(), "dilna-test-outside-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;
});

afterAll(() => {
	closeDb();
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	for (const d of [dataDir, worktree, outside]) {
		rmSync(d, { recursive: true, force: true });
	}
});

describe("sniffImageMimeType", () => {
	it.each([
		["png", PNG, "image/png"],
		["jpeg", JPEG, "image/jpeg"],
		["gif", GIF, "image/gif"],
		["webp", WEBP, "image/webp"],
	])("identifies %s from its magic bytes", (name, content, expected) => {
		const file = path.join(worktree, `sniff-${name}.bin`);
		writeFileSync(file, content);
		expect(sniffImageMimeType(file)).toBe(expected);
	});

	/** The whole point of sniffing: the extension is the model's claim about a
	 * file it chose, and `Content-Type` is what the browser acts on. */
	it("does not trust the extension", () => {
		const file = path.join(worktree, "not-really.png");
		writeFileSync(file, "<html><script>alert(1)</script></html>");
		expect(sniffImageMimeType(file)).toBeNull();
	});

	it("returns null for a file that does not exist", () => {
		expect(sniffImageMimeType(path.join(worktree, "nope.png"))).toBeNull();
	});
});

describe("sendImage", () => {
	it("copies the bytes out of the worktree into the session's attachment dir", () => {
		const src = path.join(worktree, "shot.png");
		writeFileSync(src, PNG);

		const attachment = sendImage({
			sessionId: "s-copy",
			worktreePath: worktree,
			sourcePath: "shot.png",
		});

		expect(attachment.path.startsWith(attachmentDir("s-copy"))).toBe(true);
		expect(attachment.path).not.toContain(worktree);
		expect(readFileSync(attachment.path)).toEqual(PNG);
		expect(attachment.kind).toBe("image");
		expect(attachment.mimeType).toBe("image/png");
		expect(attachment.filename).toBe("shot.png");
	});

	it("records source 'agent', distinguishing it from a user upload", () => {
		writeFileSync(path.join(worktree, "src.png"), PNG);
		const sent = sendImage({
			sessionId: "s-source",
			worktreePath: worktree,
			sourcePath: "src.png",
		});
		const uploaded = storeAttachment("s-source", {
			filename: "up.png",
			mimeType: "image/png",
			bytes: new Uint8Array(PNG),
		});

		expect(sent.source).toBe("agent");
		expect(uploaded.source).toBe("user");
		// And it survives the round trip, which is what makes it useful for audit.
		expect(getAttachment("s-source", sent.id)?.source).toBe("agent");
		expect(getAttachment("s-source", uploaded.id)?.source).toBe("user");
	});

	/** ADR-0032's reasoning, applied here: a Worktree file is mutable and
	 * deletable, so a reference would start 404ing after the user was handed it. */
	it("is immutable once sent, even if the worktree file changes", () => {
		const src = path.join(worktree, "mutable.png");
		writeFileSync(src, PNG);
		const attachment = sendImage({
			sessionId: "s-immutable",
			worktreePath: worktree,
			sourcePath: "mutable.png",
		});

		writeFileSync(src, Buffer.concat([PNG, Buffer.from("changed")]));
		expect(readFileSync(attachment.path)).toEqual(PNG);

		rmSync(src);
		expect(existsSync(attachment.path)).toBe(true);
	});

	it("accepts an absolute path inside the worktree", () => {
		const src = path.join(worktree, "abs.png");
		writeFileSync(src, PNG);
		const attachment = sendImage({
			sessionId: "s-abs",
			worktreePath: worktree,
			sourcePath: src,
		});
		expect(attachment.filename).toBe("abs.png");
	});

	it("gives two sends of the same file distinct ids and disk paths", () => {
		writeFileSync(path.join(worktree, "twice.png"), PNG);
		const a = sendImage({
			sessionId: "s-twice",
			worktreePath: worktree,
			sourcePath: "twice.png",
		});
		const b = sendImage({
			sessionId: "s-twice",
			worktreePath: worktree,
			sourcePath: "twice.png",
		});
		expect(a.id).not.toBe(b.id);
		expect(a.path).not.toBe(b.path);
	});

	it("records the size of the stored copy", () => {
		writeFileSync(path.join(worktree, "sized.gif"), GIF);
		const attachment = sendImage({
			sessionId: "s-size",
			worktreePath: worktree,
			sourcePath: "sized.gif",
		});
		expect(attachment.size).toBe(GIF.byteLength);
		expect(attachment.mimeType).toBe("image/gif");
	});
});

describe("sendImage rejections", () => {
	const reject = (sourcePath: string, sessionId = "s-reject") =>
		sendImage({ sessionId, worktreePath: worktree, sourcePath });

	it("rejects a path outside the worktree", () => {
		const target = path.join(outside, "secret.png");
		writeFileSync(target, PNG);
		expect(() => reject(target)).toThrow(AttachmentRejectedError);
		expect(() => reject(target)).toThrow(/inside this session's worktree/);
	});

	it("rejects a traversal path", () => {
		expect(() => reject("../escape.png")).toThrow(AttachmentRejectedError);
	});

	/** The case a lexical prefix check would pass and `isContained` catches. */
	it("rejects a symlink inside the worktree pointing outside it", () => {
		const target = path.join(outside, "linked.png");
		writeFileSync(target, PNG);
		const link = path.join(worktree, "link.png");
		if (!existsSync(link)) symlinkSync(target, link);

		expect(() => reject("link.png")).toThrow(/inside this session's worktree/);
	});

	it("rejects a non-image file, naming what would work", () => {
		writeFileSync(path.join(worktree, "notes.txt"), "just text");
		expect(() => reject("notes.txt")).toThrow(/not a supported image/);
		expect(() => reject("notes.txt")).toThrow(/image\/png/);
	});

	/** Belt and braces with the route's re-validation: the file claims to be a
	 * PNG and is not, so it must never become an `image/*` row at all. */
	it("rejects a non-image wearing an image extension", () => {
		writeFileSync(path.join(worktree, "fake.png"), "<html>nope</html>");
		expect(() => reject("fake.png")).toThrow(/not a supported image/);
	});

	it("rejects a missing file", () => {
		expect(() => reject("ghost.png")).toThrow(/no such file/);
	});

	it("rejects a directory", () => {
		const dir = path.join(worktree, "adir.png");
		mkdirSync(dir, { recursive: true });
		expect(() => reject("adir.png")).toThrow(/not a file/);
	});

	it("rejects an empty file", () => {
		writeFileSync(path.join(worktree, "empty.png"), "");
		expect(() => reject("empty.png")).toThrow(/empty/);
	});

	it("rejects a file over the attachment limit", () => {
		const big = Buffer.concat([PNG, Buffer.alloc(ATTACHMENT_MAX_BYTES)]);
		writeFileSync(path.join(worktree, "big.png"), big);
		expect(() => reject("big.png")).toThrow(/exceeds/);
	});

	it("rejects a blank path", () => {
		expect(() => reject("   ")).toThrow(/path is required/);
	});

	it("stores nothing when it rejects", () => {
		writeFileSync(path.join(worktree, "rejected.txt"), "nope");
		expect(() => reject("rejected.txt", "s-nothing")).toThrow();
		expect(existsSync(attachmentDir("s-nothing"))).toBe(false);
	});
});
