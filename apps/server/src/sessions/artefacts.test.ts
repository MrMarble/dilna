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
import { ARTEFACT_MAX_BYTES, type ArtefactKind } from "@dilna/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "../db";
import {
	ArtefactRejectedError,
	artefactDir,
	deleteArtefactsForSession,
	getArtefact,
	listArtefacts,
	publishArtefact,
} from "./artefacts";

let dataDir: string;
let worktree: string;
let oldDataDir: string | undefined;

beforeAll(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-artefacts-"));
	oldDataDir = process.env.DILNA_DATA_DIR;
	process.env.DILNA_DATA_DIR = dataDir;
	worktree = mkdtempSync(path.join(tmpdir(), "dilna-test-worktree-"));
});

afterAll(() => {
	closeDb();
	if (oldDataDir === undefined) delete process.env.DILNA_DATA_DIR;
	else process.env.DILNA_DATA_DIR = oldDataDir;
	rmSync(dataDir, { recursive: true, force: true });
	rmSync(worktree, { recursive: true, force: true });
});

/** Write a file into the worktree and return its worktree-relative path. */
function inWorktree(relative: string, content: string): string {
	const full = path.join(worktree, relative);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, content);
	return relative;
}

const publish = (sessionId: string, sourcePath: string, title?: string) =>
	publishArtefact({ sessionId, worktreePath: worktree, sourcePath, title });

describe("publishArtefact", () => {
	it("copies the bytes out of the worktree", () => {
		const rel = inWorktree("report.html", "<h1>hi</h1>");
		const artefact = publish("s-copy", rel);

		const stored = getArtefact("s-copy", artefact.id);
		expect(stored).not.toBeNull();
		// The copy lives under the session's artefact dir, not the worktree —
		// the whole point of ADR-0032's storage decision.
		expect(stored?.path.startsWith(artefactDir("s-copy"))).toBe(true);
		expect(stored?.path.startsWith(worktree)).toBe(false);
		expect(readFileSync(stored?.path ?? "", "utf8")).toBe("<h1>hi</h1>");
	});

	it("keeps serving the published copy after the worktree file changes", () => {
		const rel = inWorktree("mutable.html", "<p>v1</p>");
		const artefact = publish("s-immutable", rel);
		writeFileSync(path.join(worktree, rel), "<p>v2</p>");

		const stored = getArtefact("s-immutable", artefact.id);
		expect(readFileSync(stored?.path ?? "", "utf8")).toBe("<p>v1</p>");
	});

	it("mints a separate artefact per publish so versions can be compared", () => {
		const rel = inWorktree("versioned.html", "<p>first</p>");
		const first = publish("s-versions", rel, "Report");
		writeFileSync(path.join(worktree, rel), "<p>second</p>");
		const second = publish("s-versions", rel, "Report");

		expect(second.id).not.toBe(first.id);
		const firstPath = getArtefact("s-versions", first.id)?.path ?? "";
		const secondPath = getArtefact("s-versions", second.id)?.path ?? "";
		expect(firstPath).not.toBe(secondPath);
		expect(readFileSync(firstPath, "utf8")).toBe("<p>first</p>");
		expect(readFileSync(secondPath, "utf8")).toBe("<p>second</p>");
	});

	it("records provenance as a worktree-relative path", () => {
		const rel = inWorktree("docs/nested/out.html", "<p>x</p>");
		const artefact = publish("s-provenance", rel);
		expect(artefact.sourcePath).toBe("docs/nested/out.html");
	});

	it("accepts an absolute path inside the worktree", () => {
		const rel = inWorktree("abs.html", "<p>x</p>");
		const artefact = publish("s-abs", path.join(worktree, rel));
		expect(artefact.sourcePath).toBe("abs.html");
	});

	it("falls back to the filename when no title is given", () => {
		const rel = inWorktree("untitled.html", "<p>x</p>");
		expect(publish("s-untitled", rel).title).toBe("untitled.html");
	});

	it("does not expose the on-disk path to callers", () => {
		const rel = inWorktree("hidden.html", "<p>x</p>");
		// `path` is server-only: the browser fetches bytes by URL and the UI
		// must never render a host filesystem location.
		expect(publish("s-hidden", rel)).not.toHaveProperty("path");
	});

	it("scopes lookups to the owning session", () => {
		const rel = inWorktree("scoped.html", "<p>x</p>");
		const artefact = publish("s-owner", rel);
		expect(getArtefact("s-other", artefact.id)).toBeNull();
	});

	it("lists a session's artefacts newest first", () => {
		inWorktree("a.html", "<p>a</p>");
		inWorktree("b.html", "<p>b</p>");
		const first = publish("s-list", "a.html");
		const second = publish("s-list", "b.html");

		const ids = listArtefacts("s-list").map((a) => a.id);
		expect(ids).toContain(first.id);
		expect(ids).toContain(second.id);
		expect(ids).toHaveLength(2);
	});
});

/**
 * The extension→kind/MIME mapping (ADR-0043). Table-driven because the value
 * under test *is* the table: one case per accepted extension is what keeps
 * `PUBLISHABLE` and the renderers in `apps/web/src/components/artefact-render`
 * agreeing about which kinds exist, and a missing entry here is a type error
 * over there.
 */
describe("publishArtefact kinds", () => {
	const cases: Array<[string, ArtefactKind, string]> = [
		["report.html", "html", "text/html; charset=utf-8"],
		["report.htm", "html", "text/html; charset=utf-8"],
		["notes.md", "markdown", "text/markdown; charset=utf-8"],
		["notes.markdown", "markdown", "text/markdown; charset=utf-8"],
		["paper.pdf", "pdf", "application/pdf"],
		["chart.png", "image", "image/png"],
		["chart.jpg", "image", "image/jpeg"],
		["chart.jpeg", "image", "image/jpeg"],
		["chart.gif", "image", "image/gif"],
		["chart.webp", "image", "image/webp"],
	];

	it.each(cases)("maps %s to kind %s", (filename, kind, mimeType) => {
		const rel = inWorktree(filename, "content");
		const artefact = publish(`s-kind-${kind}`, rel);
		expect(artefact.kind).toBe(kind);
		expect(artefact.mimeType).toBe(mimeType);
	});

	it("matches the extension case-insensitively", () => {
		// Agents emit `REPORT.HTML` often enough that a case-sensitive map is a
		// papercut with no upside.
		const rel = inWorktree("REPORT.HTML", "<p>x</p>");
		expect(publish("s-kind-upper", rel).kind).toBe("html");
	});
});

describe("publishArtefact rejections", () => {
	it("rejects a path outside the worktree", () => {
		const outside = path.join(dataDir, "outside.html");
		writeFileSync(outside, "<p>secret</p>");
		expect(() => publish("s-reject", outside)).toThrow(ArtefactRejectedError);
	});

	it("rejects traversal out of the worktree", () => {
		expect(() => publish("s-reject", "../escape.html")).toThrow(
			ArtefactRejectedError,
		);
	});

	it("rejects a symlink inside the worktree pointing outside it", () => {
		// The bypass a lexical prefix check would miss: the path *looks*
		// worktree-relative, but the copy would read the link's target.
		const secret = path.join(dataDir, "symlink-secret.html");
		writeFileSync(secret, "<p>secret</p>");
		const link = path.join(worktree, "escape.html");
		if (!existsSync(link)) symlinkSync(secret, link);

		expect(() => publish("s-reject", "escape.html")).toThrow(
			ArtefactRejectedError,
		);
	});

	it("rejects a file type dilna cannot render", () => {
		const rel = inWorktree("notes.txt", "plain");
		expect(() => publish("s-reject", rel)).toThrow(/only .* can be published/);
	});

	/**
	 * SVG is the one omission that is a *decision* rather than a gap (ADR-0043):
	 * it is executable document markup wearing an image extension, and it would
	 * render in an `img` context where the HTML sandbox cannot be applied. If this
	 * test ever fails because someone added `".svg"` to `PUBLISHABLE`, the serve
	 * route's per-kind header split needs revisiting in the same commit.
	 */
	it("rejects SVG, which is markup rather than an image", () => {
		const rel = inWorktree(
			"chart.svg",
			'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
		);
		expect(() => publish("s-reject", rel)).toThrow(ArtefactRejectedError);
	});

	it("rejects a missing file", () => {
		expect(() => publish("s-reject", "nope.html")).toThrow(/no such file/);
	});

	it("rejects a directory", () => {
		mkdirSync(path.join(worktree, "adir.html"), { recursive: true });
		expect(() => publish("s-reject", "adir.html")).toThrow(/not a file/);
	});

	it("rejects an empty file", () => {
		const rel = inWorktree("empty.html", "");
		expect(() => publish("s-reject", rel)).toThrow(/empty/);
	});

	it("rejects a file over the size limit", () => {
		const rel = inWorktree("big.html", "x".repeat(ARTEFACT_MAX_BYTES + 1));
		expect(() => publish("s-reject", rel)).toThrow(/exceeds/);
	});

	it("rejects an empty path", () => {
		expect(() => publish("s-reject", "  ")).toThrow(/path is required/);
	});
});

describe("deleteArtefactsForSession", () => {
	it("removes the rows and the bytes", () => {
		const rel = inWorktree("doomed.html", "<p>x</p>");
		const artefact = publish("s-delete", rel);
		const stored = getArtefact("s-delete", artefact.id);
		expect(existsSync(stored?.path ?? "")).toBe(true);

		deleteArtefactsForSession("s-delete");

		expect(listArtefacts("s-delete")).toEqual([]);
		expect(existsSync(stored?.path ?? "")).toBe(false);
		expect(existsSync(artefactDir("s-delete"))).toBe(false);
	});
});
