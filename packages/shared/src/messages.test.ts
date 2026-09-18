import { describe, expect, it } from "vitest";
import {
	attachmentKindFor,
	formatAttachmentSize,
	IMAGE_MIME_TYPES,
	MAX_ATTACHMENTS_PER_MESSAGE,
} from "./messages";

/**
 * These two live in `packages/shared` rather than on either side because
 * server and web both have to agree on them (issue #53): the composer and
 * the send route enforce the same cap, and the tray, the sent-message card
 * and the Agent's prompt preamble all render the same file's size.
 */

describe("formatAttachmentSize", () => {
	it("uses bytes below 1 KB", () => {
		expect(formatAttachmentSize(0)).toBe("0 B");
		expect(formatAttachmentSize(512)).toBe("512 B");
		expect(formatAttachmentSize(1023)).toBe("1023 B");
	});

	it("uses whole kilobytes below 1 MB", () => {
		expect(formatAttachmentSize(1024)).toBe("1 KB");
		expect(formatAttachmentSize(2048)).toBe("2 KB");
	});

	it("uses one decimal place at megabyte scale", () => {
		expect(formatAttachmentSize(1024 * 1024)).toBe("1.0 MB");
		expect(formatAttachmentSize(1.5 * 1024 * 1024)).toBe("1.5 MB");
	});
});

describe("MAX_ATTACHMENTS_PER_MESSAGE", () => {
	// The drift this constant exists to prevent: the send route's schema once
	// said 20 while the resolver said 10, so a 15-id send passed validation
	// and then failed downstream.
	it("is a positive integer both sides can enforce", () => {
		expect(Number.isInteger(MAX_ATTACHMENTS_PER_MESSAGE)).toBe(true);
		expect(MAX_ATTACHMENTS_PER_MESSAGE).toBeGreaterThan(0);
	});
});

/**
 * Which channel a file takes to the Agent is decided once at upload and
 * stored, so both sides must classify identically — server-side it picks the
 * prompt channel, web-side it decides whether to show a thumbnail. Two
 * implementations had already drifted: the server's strict allow-list called
 * `image/heic` a document while the web's `startsWith("image/")` called it an
 * image, so the same file previewed in the composer and then rendered as a
 * file card after sending.
 */
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

	it("exposes the allow-list it classifies against", () => {
		expect([...IMAGE_MIME_TYPES].sort()).toEqual([
			"image/gif",
			"image/jpeg",
			"image/png",
			"image/webp",
		]);
	});
});
