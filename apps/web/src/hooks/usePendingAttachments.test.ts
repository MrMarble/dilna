import { describe, expect, it } from "vitest";
import { previewsInline } from "@/hooks/usePendingAttachments";

/**
 * Whether a picked file gets a thumbnail in the composer tray.
 *
 * This keys off the *shared* `attachmentKindFor`, so it must agree with the
 * kind the server stores. It previously used a loose `startsWith("image/")`
 * test, which called `image/heic` (and `image/tiff`, `image/svg+xml`) an image
 * while the server called it a document — so the same file previewed in the
 * tray and then rendered as a card after sending.
 */
describe("previewsInline", () => {
	it.each([
		"image/png",
		"image/jpeg",
		"image/gif",
		"image/webp",
	])("previews the supported image type %s", (mime) => {
		expect(previewsInline(mime)).toBe(true);
	});

	it("does not preview an image type the Provider can't be sent", () => {
		// The regression this pins: `startsWith("image/")` said yes to all of
		// these, and the server said "document" to all of them.
		expect(previewsInline("image/heic")).toBe(false);
		expect(previewsInline("image/tiff")).toBe(false);
		expect(previewsInline("image/svg+xml")).toBe(false);
	});

	it("does not preview a non-image", () => {
		expect(previewsInline("application/pdf")).toBe(false);
		expect(previewsInline("")).toBe(false);
	});
});
