import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtefactViewer } from "@/components/ArtefactViewer";
import { makeArtefact } from "@/test/factories";

/**
 * The artefact viewer's kind dispatch and markdown raw toggle (ADR-0043).
 *
 * The security-relevant assertions live in the server's
 * `artefacts.integration.test.ts` (the header set) and in the renderers
 * themselves; what this file pins is the thing tests are the only guard
 * against — that a new kind reaches the *right* renderer, and that "raw"
 * means raw rather than silently rendered.
 *
 * `artefactUrl` is mocked because the point is what the viewer does with a
 * URL, not what `paths.ts` builds (which `paths.contract.test.ts` covers).
 */

const artifactUrl = (sessionId: string, artefactId: string) =>
	`/api/sessions/${sessionId}/artefacts/${artefactId}`;

vi.mock("@/api/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/api/client")>()),
	artefactUrl: (sessionId: string, artefactId: string) =>
		artifactUrl(sessionId, artefactId),
}));

const MD = "# Title\n\nBody **bold** text.\n";

function stubFetch(body: string, contentType = "text/markdown; charset=utf-8") {
	const fetchMock = vi.fn(async () => {
		return new Response(body, {
			status: 200,
			headers: { "Content-Type": contentType },
		});
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

beforeEach(() => {
	// Reset per test: the viewer is a Dialog and base-ui portals into body,
	// which testing-library's cleanup handles, but global fetch stubs are not.
	vi.unstubAllGlobals();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ArtefactViewer", () => {
	it("renders an html artefact in a fully sandboxed iframe", () => {
		const artefact = makeArtefact({ kind: "html" });
		render(
			<ArtefactViewer
				sessionId="sess-1"
				artefact={artefact}
				onClose={vi.fn()}
			/>,
		);

		const frame = screen.getByTitle("Coverage report");
		expect(frame.tagName).toBe("IFRAME");
		expect(frame.getAttribute("src")).toBe(
			"/api/sessions/sess-1/artefacts/art-1",
		);
		// An empty sandbox attribute means *no* tokens, which is the point: no
		// scripts, no same-origin access. `allow-scripts` here would be the
		// regression ADR-0032 exists to prevent.
		expect(frame.getAttribute("sandbox")).toBe("");
	});

	it("renders a pdf in an iframe that is deliberately not sandboxed", () => {
		const artefact = makeArtefact({
			kind: "pdf",
			filename: "paper.pdf",
			mimeType: "application/pdf",
		});
		render(
			<ArtefactViewer
				sessionId="sess-1"
				artefact={artefact}
				onClose={vi.fn()}
			/>,
		);

		const frame = screen.getByTitle("Coverage report");
		expect(frame.tagName).toBe("IFRAME");
		// A `sandbox` attribute stops Chrome handing the response to its native
		// PDF viewer, so the frame renders blank. This is why the html and pdf
		// arms differ and why the header split in the serve route exists.
		expect(frame.hasAttribute("sandbox")).toBe(false);
	});

	it("renders an image artefact as an img, not an iframe", () => {
		const artefact = makeArtefact({
			kind: "image",
			filename: "chart.png",
			mimeType: "image/png",
		});
		render(
			<ArtefactViewer
				sessionId="sess-1"
				artefact={artefact}
				onClose={vi.fn()}
			/>,
		);

		const img = screen.getByAltText("Coverage report");
		expect(img.tagName).toBe("IMG");
		expect(img.getAttribute("src")).toBe(
			"/api/sessions/sess-1/artefacts/art-1",
		);
		expect(screen.queryByTitle("Coverage report")).toBeNull();
	});

	it("renders markdown rather than showing its source", async () => {
		stubFetch(MD);
		const artefact = makeArtefact({
			kind: "markdown",
			filename: "notes.md",
			mimeType: "text/markdown; charset=utf-8",
		});
		render(
			<ArtefactViewer
				sessionId="sess-1"
				artefact={artefact}
				onClose={vi.fn()}
			/>,
		);

		// Rendered: the `**bold**` became <strong> and the `#` became a heading,
		// so neither the hashes nor the asterisks survive as text.
		await waitFor(() =>
			expect(
				screen.getByRole("heading", { name: "Title" }),
			).toBeInTheDocument(),
		);
		expect(screen.getByText("bold").tagName).toBe("STRONG");
		expect(screen.queryByText(/# Title/)).toBeNull();
	});

	it("toggles markdown to its verbatim source and back", async () => {
		const user = userEvent.setup();
		const fetchMock = stubFetch(MD);
		const artefact = makeArtefact({
			kind: "markdown",
			filename: "notes.md",
			mimeType: "text/markdown; charset=utf-8",
		});
		render(
			<ArtefactViewer
				sessionId="sess-1"
				artefact={artefact}
				onClose={vi.fn()}
			/>,
		);

		await waitFor(() =>
			expect(
				screen.getByRole("heading", { name: "Title" }),
			).toBeInTheDocument(),
		);

		await user.click(screen.getByRole("button", { name: "Show raw source" }));

		// Raw means verbatim: the hash and the asterisks are back, unrendered.
		expect(screen.getByText(/# Title/)).toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: "Title" })).toBeNull();

		await user.click(screen.getByRole("button", { name: "Show rendered" }));
		await waitFor(() =>
			expect(
				screen.getByRole("heading", { name: "Title" }),
			).toBeInTheDocument(),
		);

		// The bytes are immutable, so toggling must not refetch them: a toggle
		// that round-trips is a toggle that can fail.
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("offers no raw toggle for a kind that has no raw form", () => {
		const artefact = makeArtefact({ kind: "image", mimeType: "image/png" });
		render(
			<ArtefactViewer
				sessionId="sess-1"
				artefact={artefact}
				onClose={vi.fn()}
			/>,
		);

		expect(
			screen.queryByRole("button", { name: "Show raw source" }),
		).toBeNull();
	});

	it("shows an error state when the markdown fetch fails", async () => {
		const fetchMock = vi.fn(async () => new Response("", { status: 500 }));
		vi.stubGlobal("fetch", fetchMock);

		const artefact = makeArtefact({
			kind: "markdown",
			mimeType: "text/markdown; charset=utf-8",
		});
		render(
			<ArtefactViewer
				sessionId="sess-1"
				artefact={artefact}
				onClose={vi.fn()}
			/>,
		);

		expect(await screen.findByText(/Could not load/)).toBeInTheDocument();
	});

	it("refuses to treat a non-text response as markdown", async () => {
		// If the route ever started returning an image or HTML-with-a-non-text
		// type for a markdown artefact, the viewer must error rather than hand
		// whatever it got to the markdown renderer.
		stubFetch("\u0000binary", "application/octet-stream");
		const artefact = makeArtefact({
			kind: "markdown",
			mimeType: "text/markdown; charset=utf-8",
		});
		render(
			<ArtefactViewer
				sessionId="sess-1"
				artefact={artefact}
				onClose={vi.fn()}
			/>,
		);

		expect(await screen.findByText(/Could not load/)).toBeInTheDocument();
	});
});
