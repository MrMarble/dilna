import { describe, expect, it } from "vitest";
import { agentLabel } from "./agent-labels";

describe("agentLabel", () => {
	it("returns the known display label for a current AgentType", () => {
		expect(agentLabel("pi")).toBe("pi");
		expect(agentLabel("openai")).toBe("OpenAI");
	});

	it("falls back to the raw value for a legacy agentType this build doesn't know", () => {
		// A pre-migration session row can still hold agent_type='claude' —
		// SQLite has no CHECK constraint, so old rows survive the schema
		// migration untouched (see docs/research/pi-agent-type-migration.md).
		expect(agentLabel("claude")).toBe("claude");
	});
});
