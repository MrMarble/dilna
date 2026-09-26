import type { ComparisonResponse, SessionView } from "@dilna/shared";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { errorHandler } from "../middleware/errors";
import { RepoNotFoundError } from "../repos/manager";
import { InvalidModelError, type SessionManager } from "../sessions/manager";
import { createComparisonsRoute } from "./comparisons";

// The handlers below only translate manager results/errors into statuses and
// envelopes, so the manager is a stub — the real one's lifecycle (worktrees,
// agents, DB) is manager.test.ts's territory.
function stubManager(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		createComparison: vi.fn(async () => ({
			groupId: "grp-1",
			sessions: [sessionView("arm-0"), sessionView("arm-1")],
		})),
		getComparison: vi.fn(async (groupId: string) =>
			groupId === "grp-1" ? [sessionView("arm-0"), sessionView("arm-1")] : null,
		),
		...overrides,
	} as unknown as SessionManager;
}

function sessionView(id: string): SessionView {
	return {
		id,
		repoId: "repo-1",
		title: `Session ${id.slice(0, 4)}`,
		agentType: "pi",
		kind: "session",
		status: "idle",
		usage: { inputTokens: 0, outputTokens: 0 },
		provider: "anthropic",
		model: "claude-opus-4-5",
		createdAt: 1_700_000_000,
		lastActiveAt: 1_700_000_000,
	};
}

const validBody = {
	repoId: "repo-1",
	prompt: "Explain the build system.",
	models: [
		{ provider: "anthropic", model: "claude-opus-4-5" },
		{ provider: "deepseek", model: "deepseek-chat" },
	],
};

describe("comparisonsRoute validation", () => {
	// zod validation runs before any handler, so the stub manager below is
	// never touched by these — same reasoning as sessions.test.ts.
	const manager = stubManager();
	const app = new Hono().route(
		"/",
		createComparisonsRoute({ sessions: manager }),
	);

	it("rejects POST / with no models", async () => {
		const res = await app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ repoId: "repo-1", prompt: "hi" }),
		});
		expect(res.status).toBe(422);
	});

	it("rejects POST / with a single model — a one-arm comparison is just a session", async () => {
		const res = await app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				repoId: "repo-1",
				prompt: "hi",
				models: [{ provider: "anthropic", model: "claude-opus-4-5" }],
			}),
		});
		expect(res.status).toBe(422);
	});

	it("rejects POST / with more arms than the shared cap allows", async () => {
		const res = await app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				repoId: "repo-1",
				prompt: "hi",
				models: Array.from({ length: 5 }, () => ({
					provider: "anthropic",
					model: "claude-opus-4-5",
				})),
			}),
		});
		expect(res.status).toBe(422);
	});

	it("rejects POST / with an arm missing its provider", async () => {
		const res = await app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				repoId: "repo-1",
				prompt: "hi",
				models: [
					{ provider: "anthropic", model: "claude-opus-4-5" },
					{ model: "deepseek-chat" },
				],
			}),
		});
		expect(res.status).toBe(422);
	});

	it("rejects POST / with an empty prompt", async () => {
		const res = await app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				repoId: "repo-1",
				prompt: "",
				models: validBody.models,
			}),
		});
		expect(res.status).toBe(422);
	});
});

describe("comparisonsRoute handlers", () => {
	// Mounts the same onError as index.ts, so these assert the envelope shape
	// clients actually receive (sessions.test.ts's precedent).
	function appWith(manager: SessionManager) {
		return new Hono()
			.onError(errorHandler)
			.route("/", createComparisonsRoute({ sessions: manager }));
	}

	// res.json() returns `unknown`; cast through the envelope the route
	// annotates (ADR-0040) rather than re-narrowing by hand at each use.
	const asJson = async (res: Response) =>
		(await res.json()) as {
			comparison?: ComparisonResponse["comparison"];
			error?: { message: string };
		};

	it("creates the comparison and returns its envelope", async () => {
		const manager = stubManager();
		const app = appWith(manager);
		const res = await app.request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody),
		});
		expect(res.status).toBe(201);
		const body = await asJson(res);
		expect(body.comparison).toEqual({
			id: "grp-1",
			repoId: "repo-1",
			createdAt: 1_700_000_000,
			sessions: [sessionView("arm-0"), sessionView("arm-1")],
		});
		expect(manager.createComparison).toHaveBeenCalledWith(
			"repo-1",
			"Explain the build system.",
			validBody.models,
		);
	});

	it("maps an unknown repo to 404", async () => {
		const manager = stubManager({
			createComparison: vi.fn(async () => {
				throw new RepoNotFoundError("repo-1");
			}),
		});
		const res = await appWith(manager).request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody),
		});
		expect(res.status).toBe(404);
	});

	it("maps an invalid model choice to 400, not 500", async () => {
		const manager = stubManager({
			createComparison: vi.fn(async () => {
				throw new InvalidModelError(
					'nope-1 is not a known model for provider "anthropic".',
				);
			}),
		});
		const res = await appWith(manager).request("/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(validBody),
		});
		expect(res.status).toBe(400);
		const body = await asJson(res);
		expect(body.error?.message).toContain("not a known model");
	});

	it("returns the arms envelope for a known group id", async () => {
		const res = await appWith(stubManager()).request("/grp-1");
		expect(res.status).toBe(200);
		const body = await asJson(res);
		expect(body.comparison?.id).toBe("grp-1");
		expect(body.comparison?.sessions).toHaveLength(2);
	});

	it("404s an unknown group id", async () => {
		const res = await appWith(stubManager()).request("/grp-nope");
		expect(res.status).toBe(404);
	});
});
