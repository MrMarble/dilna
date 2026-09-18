import { describe, expect, it } from "vitest";
import {
	createCustomProviderBodySchema,
	pushSubscribeBodySchema,
	usageQuerySchema,
} from "./apiSchemas";

describe("usageQuerySchema", () => {
	it("accepts the 'all' sentinel and positive integers", () => {
		expect(usageQuerySchema.parse({ days: "all" }).days).toBe("all");
		expect(usageQuerySchema.parse({ days: "30" }).days).toBe(30);
		expect(usageQuerySchema.parse({}).days).toBeUndefined();
	});

	// The bug this replaced: the route ran a bare `Number(days)`, so `?days=abc`
	// produced NaN and passed it into getUsageSummary(since) as a timestamp.
	it("rejects a non-numeric days rather than coercing it to NaN", () => {
		const result = usageQuerySchema.safeParse({ days: "abc" });
		expect(result.success).toBe(false);
	});

	it("rejects zero, negative, and absurd ranges", () => {
		expect(usageQuerySchema.safeParse({ days: "0" }).success).toBe(false);
		expect(usageQuerySchema.safeParse({ days: "-5" }).success).toBe(false);
		expect(usageQuerySchema.safeParse({ days: "99999" }).success).toBe(false);
	});
});

describe("createCustomProviderBodySchema", () => {
	const valid = {
		id: "ollama",
		name: "Ollama",
		baseUrl: "http://localhost:11434/v1",
		api: "openai-completions",
		models: [{ id: "llama3" }],
	};

	it("accepts a well-formed provider", () => {
		expect(createCustomProviderBodySchema.safeParse(valid).success).toBe(true);
	});

	// The old hand-rolled guard only checked `Array.isArray(models)`, so these
	// reached setCustomProvider and were persisted.
	it("rejects model entries that aren't well-formed objects", () => {
		expect(
			createCustomProviderBodySchema.safeParse({ ...valid, models: [null] })
				.success,
		).toBe(false);
		expect(
			createCustomProviderBodySchema.safeParse({ ...valid, models: [1, 2, 3] })
				.success,
		).toBe(false);
	});

	// The client used to type this as a bare `string` while the server had a
	// four-literal union — the one place the duplicated types had drifted.
	it("rejects an unknown api flavour", () => {
		expect(
			createCustomProviderBodySchema.safeParse({ ...valid, api: "gopher" })
				.success,
		).toBe(false);
	});
});

describe("pushSubscribeBodySchema", () => {
	const keys = { p256dh: "BPublicKeyBytes", auth: "AuthSecret" };

	it("accepts a real push endpoint", () => {
		expect(
			pushSubscribeBodySchema.safeParse({
				endpoint: "https://fcm.googleapis.com/fcm/send/abc",
				keys,
			}).success,
		).toBe(true);
	});

	// The endpoint becomes a server-side fetch target, so these are SSRF
	// vectors rather than merely malformed rows.
	it.each([
		"file:///etc/passwd",
		"http://localhost:6379/",
		"http://169.254.169.254/latest/meta-data/",
		"not-a-url",
	])("rejects a non-HTTPS endpoint (%s)", (endpoint) => {
		expect(pushSubscribeBodySchema.safeParse({ endpoint, keys }).success).toBe(
			false,
		);
	});
});
