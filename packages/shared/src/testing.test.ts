import { describe, expect, it } from "vitest";
import { makeAttachment, makeRepo, makeSession } from "./testing";

describe("makeSession", () => {
	it("builds an idle session on repo-1 by default", () => {
		expect(makeSession()).toEqual({
			id: "sess-1",
			repoId: "repo-1",
			title: "New session",
			agentType: "pi",
			kind: "session",
			status: "idle",
			usage: { inputTokens: 0, outputTokens: 0 },
			createdAt: 1,
			lastActiveAt: 1,
		});
	});

	it("applies overrides over the defaults", () => {
		const session = makeSession({ id: "sess-9", status: "working" });
		expect(session.id).toBe("sess-9");
		expect(session.status).toBe("working");
		// Untouched fields keep their defaults.
		expect(session.repoId).toBe("repo-1");
	});
});

describe("makeRepo", () => {
	it("builds the dilna repo by default", () => {
		expect(makeRepo()).toEqual({
			id: "repo-1",
			slug: "dilna",
			path: "/tmp/dilna",
			defaultBranch: "main",
			remoteUrl: "git@github.com:owner/dilna.git",
			createdAt: 1,
		});
	});

	it("applies overrides", () => {
		expect(makeRepo({ slug: "other" }).slug).toBe("other");
	});
});

describe("makeAttachment", () => {
	it("builds an image attachment on sess-1 by default", () => {
		const attachment = makeAttachment();
		expect(attachment.sessionId).toBe("sess-1");
		expect(attachment.kind).toBe("image");
		expect(attachment.filename).toBe("diagram.png");
	});

	it("applies overrides", () => {
		const attachment = makeAttachment({ filename: "shot.png", size: 10 });
		expect(attachment.filename).toBe("shot.png");
		expect(attachment.size).toBe(10);
		expect(attachment.mimeType).toBe("image/png");
	});
});
