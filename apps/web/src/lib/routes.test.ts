import { describe, expect, it } from "vitest";
import {
	isReservedSlug,
	parseRoute,
	type Route,
	routePath,
} from "@/lib/routes";

describe("parseRoute", () => {
	it("maps the root path to home", () => {
		expect(parseRoute("/")).toEqual({ kind: "home" });
		expect(parseRoute("")).toEqual({ kind: "home" });
	});

	it("maps the standalone views to their own routes", () => {
		expect(parseRoute("/metrics")).toEqual({ kind: "metrics" });
		expect(parseRoute("/settings")).toEqual({ kind: "settings" });
	});

	it("maps a bare repo path to that repo with no session", () => {
		expect(parseRoute("/dilna")).toEqual({
			kind: "repo",
			repoSlug: "dilna",
			sessionId: null,
		});
	});

	it("maps a repo/session path to both", () => {
		expect(parseRoute("/dilna/sess-1")).toEqual({
			kind: "repo",
			repoSlug: "dilna",
			sessionId: "sess-1",
		});
	});

	it("gives orchestrator sessions a top-level route, not a repo one", () => {
		// ADR-0021: the orchestrator is global, and its meta-repo is hidden
		// from `repos` — so it can't be addressed as /<repo-slug>/<session>.
		expect(parseRoute("/orchestrator/sess-9")).toEqual({
			kind: "orchestrator",
			sessionId: "sess-9",
		});
		expect(parseRoute("/orchestrator")).toEqual({
			kind: "orchestrator",
			sessionId: null,
		});
	});

	it("ignores trailing slashes and empty segments", () => {
		expect(parseRoute("/dilna/")).toEqual({
			kind: "repo",
			repoSlug: "dilna",
			sessionId: null,
		});
		expect(parseRoute("//metrics//")).toEqual({ kind: "metrics" });
	});
});

describe("routePath", () => {
	const cases: Array<[Route, string]> = [
		[{ kind: "home" }, "/"],
		[{ kind: "metrics" }, "/metrics"],
		[{ kind: "settings" }, "/settings"],
		[{ kind: "orchestrator", sessionId: null }, "/orchestrator"],
		[{ kind: "orchestrator", sessionId: "s1" }, "/orchestrator/s1"],
		[{ kind: "repo", repoSlug: "dilna", sessionId: null }, "/dilna"],
		[{ kind: "repo", repoSlug: "dilna", sessionId: "s1" }, "/dilna/s1"],
	];

	for (const [route, path] of cases) {
		it(`renders ${route.kind} as ${path}`, () => {
			expect(routePath(route)).toBe(path);
		});
	}

	it("round-trips every route through its path", () => {
		for (const [route, path] of cases) {
			expect(parseRoute(path)).toEqual(route);
		}
	});
});

describe("isReservedSlug", () => {
	it("flags slugs that a standalone view's path would shadow", () => {
		expect(isReservedSlug("metrics")).toBe(true);
		expect(isReservedSlug("settings")).toBe(true);
		expect(isReservedSlug("orchestrator")).toBe(true);
	});

	it("leaves ordinary repo slugs alone", () => {
		expect(isReservedSlug("dilna")).toBe(false);
		expect(isReservedSlug("my-metrics")).toBe(false);
	});
});
