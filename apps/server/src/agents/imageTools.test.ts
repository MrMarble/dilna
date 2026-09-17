import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Attachment } from "@dilna/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../db";
import { createSendImageTool } from "./imageTools";

/**
 * `dilna_send_image`'s own contract (issue #222, ADR-0038) — in particular
 * that a rejection comes back as *tool output* rather than a thrown error, so
 * the Agent can fix the path and retry instead of failing the whole turn.
 */

let dataDir: string;
let worktree: string;
let oldDataDir: string | undefined;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

beforeAll(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-imagetool-"));
	worktree = mkdtempSync(path.join(tmpdir(), "dilna-test-imagetool-wt-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;
});

afterAll(() => {
	closeDb();
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(worktree, { recursive: true, force: true });
});

function toolFor(sessionId: string) {
	const sent: {
		attachment: Attachment;
		toolCallId: string;
		caption?: string;
	}[] = [];
	const tool = createSendImageTool({
		sessionId,
		worktreePath: worktree,
		onImageSent: (attachment, ctx) => sent.push({ attachment, ...ctx }),
	});
	return { tool, sent };
}

/** The library's result type only carries `isError` on its error arm, so both
 * fields are read through one narrowing helper rather than per-assertion
 * casts. */
function resultOf(result: unknown): { text: string; isError: boolean } {
	const r = result as {
		content?: { text?: string }[];
		isError?: boolean;
	};
	return {
		text: (r.content ?? []).map((c) => c.text ?? "").join(""),
		isError: r.isError === true,
	};
}

describe("createSendImageTool", () => {
	it("is named and described for the transcript, not the artefact panel", () => {
		const { tool } = toolFor("s-meta");
		expect(tool.name).toBe("dilna_send_image");
		expect(tool.label).toBe("Send image");
		// Points the Agent at the other tool rather than silently being the
		// wrong choice for an HTML report.
		expect(tool.description).toContain("dilna_publish_artefact");
	});

	it("sends the image and reports the sink with its tool call id", async () => {
		writeFileSync(path.join(worktree, "ok.png"), PNG);
		const { tool, sent } = toolFor("s-ok");

		const result = resultOf(await tool.execute("call-1", { path: "ok.png" }));

		expect(result.isError).toBe(false);
		expect(result.text).toContain("ok.png");
		expect(sent).toHaveLength(1);
		expect(sent[0]?.toolCallId).toBe("call-1");
		expect(sent[0]?.attachment.source).toBe("agent");
		expect(sent[0]?.caption).toBeUndefined();
	});

	it("passes a caption through, trimmed", async () => {
		writeFileSync(path.join(worktree, "cap.png"), PNG);
		const { tool, sent } = toolFor("s-cap");

		await tool.execute("call-2", {
			path: "cap.png",
			caption: "  The homepage after the fix  ",
		});

		expect(sent[0]?.caption).toBe("The homepage after the fix");
	});

	it("treats a blank caption as no caption", async () => {
		writeFileSync(path.join(worktree, "blank.png"), PNG);
		const { tool, sent } = toolFor("s-blank");

		await tool.execute("call-3", { path: "blank.png", caption: "   " });

		expect(sent[0]?.caption).toBeUndefined();
	});

	/** A rejection is something the Agent can act on, so it belongs in the
	 * transcript rather than failing the turn. */
	it("returns a rejection as tool output instead of throwing", async () => {
		const { tool, sent } = toolFor("s-reject");

		const result = resultOf(
			await tool.execute("call-4", { path: "missing.png" }),
		);

		expect(result.isError).toBe(true);
		expect(result.text).toMatch(/Could not send/);
		expect(result.text).toMatch(/no such file/);
		// Nothing reached the transcript, so no empty image row is minted.
		expect(sent).toHaveLength(0);
	});

	it("does not notify the sink when the file is not really an image", async () => {
		writeFileSync(path.join(worktree, "lying.png"), "<html>nope</html>");
		const { tool, sent } = toolFor("s-lying");

		const result = resultOf(
			await tool.execute("call-5", { path: "lying.png" }),
		);

		expect(result.isError).toBe(true);
		expect(result.text).toMatch(/not a supported image/);
		expect(sent).toHaveLength(0);
	});
});
