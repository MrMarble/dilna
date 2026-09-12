import { describe, expect, it } from "vitest";
import { formatAttachmentSize, MAX_ATTACHMENTS_PER_MESSAGE } from "./messages";

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
