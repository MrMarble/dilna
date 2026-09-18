import { describe, expect, it } from "vitest";
import { paths } from "./paths";

/**
 * The HTTP address half of the API contract. ADR-0039/0040 named the request
 * bodies and the response envelopes; the paths stayed hand-typed strings on
 * both sides, so renaming `/changed-files` to `/changed_files` server-side was
 * a green build and a runtime 404 on the web. These builders are the single
 * source for both — the server declares its routes from them and the client
 * calls through them.
 */
describe("paths", () => {
	it("builds the repo collection and item paths", () => {
		expect(paths.repos.list()).toBe("/api/repos");
		expect(paths.repos.get("r1")).toBe("/api/repos/r1");
		expect(paths.repos.stats("r1")).toBe("/api/repos/r1/stats");
		expect(paths.repos.pull("r1")).toBe("/api/repos/r1/pull");
		expect(paths.repos.sync("r1")).toBe("/api/repos/r1/sync");
	});

	it("builds the session collection and item paths", () => {
		expect(paths.sessions.list()).toBe("/api/sessions");
		expect(paths.sessions.get("s1")).toBe("/api/sessions/s1");
		expect(paths.sessions.messages("s1")).toBe("/api/sessions/s1/messages");
		expect(paths.sessions.changedFiles("s1")).toBe(
			"/api/sessions/s1/changed-files",
		);
		expect(paths.sessions.commits("s1")).toBe("/api/sessions/s1/commits");
		expect(paths.sessions.stop("s1")).toBe("/api/sessions/s1/stop");
		expect(paths.sessions.stream("s1")).toBe("/api/sessions/s1/stream");
		expect(paths.sessions.transcript("s1")).toBe("/api/sessions/s1/transcript");
	});

	it("builds the queue paths, including the addressed entry", () => {
		expect(paths.sessions.queue("s1")).toBe("/api/sessions/s1/queue");
		expect(paths.sessions.queuedMessage("s1", "q1")).toBe(
			"/api/sessions/s1/queue/q1",
		);
	});

	it("builds the attachment and artefact byte paths", () => {
		expect(paths.sessions.attachments("s1")).toBe(
			"/api/sessions/s1/attachments",
		);
		expect(paths.sessions.attachment("s1", "a1")).toBe(
			"/api/sessions/s1/attachments/a1",
		);
		expect(paths.sessions.artefacts("s1")).toBe("/api/sessions/s1/artefacts");
		expect(paths.sessions.artefact("s1", "art1")).toBe(
			"/api/sessions/s1/artefacts/art1",
		);
	});

	it("builds the remaining collection paths", () => {
		expect(paths.config.get()).toBe("/api/config");
		expect(paths.config.credentials()).toBe("/api/config/credentials");
		expect(paths.config.credential("anthropic")).toBe(
			"/api/config/credentials/anthropic",
		);
		expect(paths.config.customProviders()).toBe("/api/config/custom-providers");
		expect(paths.config.customProvider("p1")).toBe(
			"/api/config/custom-providers/p1",
		);
		expect(paths.skills.list()).toBe("/api/skills");
		expect(paths.skills.forRepo("r1")).toBe("/api/skills/repo/r1");
		// The skill id is already encoded by the caller (`encodeSkillId`), so
		// the builder must *not* encode it again — double-encoding would change
		// the id the route decodes.
		expect(paths.skills.item("cGxhaW4")).toBe("/api/skills/cGxhaW4");
		expect(paths.skills.enabled("cGxhaW4")).toBe("/api/skills/cGxhaW4/enabled");
		expect(paths.push.key()).toBe("/api/push/key");
		expect(paths.push.subscribe()).toBe("/api/push/subscribe");
		expect(paths.push.unsubscribe()).toBe("/api/push/unsubscribe");
		expect(paths.usage.summary()).toBe("/api/usage");
		expect(paths.usage.disk()).toBe("/api/usage/disk");
		expect(paths.stream()).toBe("/api/stream");
	});

	it("encodes path segments that could otherwise break the URL", () => {
		// A skill id contains slashes; a repo id or session id is opaque.
		expect(paths.sessions.get("a/b")).toBe("/api/sessions/a%2Fb");
		expect(paths.repos.get("a b")).toBe("/api/repos/a%20b");
	});

	it("encodes query parameters", () => {
		expect(paths.sessions.list("r1")).toBe("/api/sessions?repoId=r1");
		expect(paths.sessions.list("a b")).toBe("/api/sessions?repoId=a%20b");
		expect(paths.usage.summary(7)).toBe("/api/usage?days=7");
		expect(paths.skills.search("hello world")).toBe(
			"/api/skills/search?q=hello%20world",
		);
	});
});
