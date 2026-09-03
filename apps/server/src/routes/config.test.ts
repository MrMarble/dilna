import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { primeOverrideFromDb } from "../agents/providerConfigStore";
import { closeDb } from "../db";
import { configRoute } from "./config";

let dataDir: string;
let oldEnv: Record<string, string | undefined>;
const app = new Hono().route("/api/config", configRoute);

beforeEach(() => {
	dataDir = mkdtempSync(path.join(tmpdir(), "dilna-test-config-route-"));
	oldEnv = {
		DILNA_DATA_DIR: process.env.DILNA_DATA_DIR,
		DILNA_PROVIDER: process.env.DILNA_PROVIDER,
		DILNA_MODEL: process.env.DILNA_MODEL,
		ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
		DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
		MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
		ZAI_API_KEY: process.env.ZAI_API_KEY,
	};
	process.env.DILNA_DATA_DIR = dataDir;
	process.env.DILNA_PROVIDER = "anthropic";
	process.env.DILNA_MODEL = "claude-opus-4-5";
	process.env.ANTHROPIC_API_KEY = "sk-anthropic";
	process.env.DEEPSEEK_API_KEY = "sk-deepseek";
	process.env.MOONSHOT_API_KEY = "sk-moonshot";
	process.env.ZAI_API_KEY = "sk-zai";
	primeOverrideFromDb();
});

afterEach(() => {
	closeDb();
	for (const [k, v] of Object.entries(oldEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	rmSync(dataDir, { recursive: true, force: true });
});

describe("GET /api/config", () => {
	it("reports no override when unset, with env as the fallback/effective", async () => {
		const res = await app.request("/api/config");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			override: unknown;
			envDefault: { provider: string };
			modelsByProvider: Record<string, unknown[]>;
		};
		expect(body.override).toBeNull();
		expect(body.envDefault.provider).toBe("anthropic");
		// The four allowlisted providers are all present as model-option keys.
		expect(Object.keys(body.modelsByProvider).sort()).toEqual([
			"anthropic",
			"deepseek",
			"moonshotai",
			"zai",
		]);
	});

	it("lists models (id + name) for each provider", async () => {
		const res = await app.request("/api/config");
		const body = (await res.json()) as {
			modelsByProvider: Record<string, { id: string; name: string }[]>;
		};
		const anthropicModels = body.modelsByProvider.anthropic ?? [];
		expect(anthropicModels.length).toBeGreaterThan(0);
		const first = anthropicModels.find(() => true);
		expect(first).toBeDefined();
		if (first) {
			expect(first.id).toEqual(expect.any(String));
			expect(first.name).toEqual(expect.any(String));
		}
	});
});

describe("PUT /api/config", () => {
	it("persists an override that then reports as in-effect", async () => {
		const res = await app.request("/api/config", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				provider: "deepseek",
				model: "deepseek-v4-flash",
			}),
		});
		expect(res.status).toBe(200);

		const get = await app.request("/api/config");
		const body = (await get.json()) as {
			override: { provider: string; model: string };
			effective: { provider: string; model: string };
		};
		expect(body.override).toEqual({
			provider: "deepseek",
			model: "deepseek-v4-flash",
		});
		expect(body.effective).toEqual({
			provider: "deepseek",
			model: "deepseek-v4-flash",
		});
	});

	it("rejects an out-of-allowlist provider", async () => {
		const res = await app.request("/api/config", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ provider: "kimi-coding", model: "k3" }),
		});
		expect(res.status).toBe(400);
		// hono's HTTPException renders the message as plain text, not JSON.
		expect(await res.text()).toContain("not a supported provider");
	});
});

describe("DELETE /api/config", () => {
	it("clears an override so the env fallback returns", async () => {
		const put = await app.request("/api/config", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				provider: "deepseek",
				model: "deepseek-v4-flash",
			}),
		});
		expect(put.status).toBe(200);

		const del = await app.request("/api/config", { method: "DELETE" });
		expect(del.status).toBe(200);

		const get = await app.request("/api/config");
		const body = (await get.json()) as {
			override: unknown;
			effective: { provider: string };
		};
		expect(body.override).toBeNull();
		expect(body.effective.provider).toBe("anthropic");
	});
});
