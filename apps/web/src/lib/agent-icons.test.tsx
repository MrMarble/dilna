import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AgentIcon } from "./agent-icons";

/** Simple Icons components render an SVG whose <title> is the brand name;
 * lucide icons render no <title>. That difference is the observable seam
 * between "brand icon picked" and "fell back to the generic glyph". */
function svgTitle(ui: React.ReactElement): string | null {
	const { container } = render(ui);
	return container.querySelector("svg title")?.textContent ?? null;
}

describe("AgentIcon", () => {
	it("shows the provider's brand icon when the Session has a mapped provider", () => {
		expect(svgTitle(<AgentIcon agentType="pi" provider="anthropic" />)).toBe(
			"Anthropic",
		);
		expect(svgTitle(<AgentIcon agentType="pi" provider="deepseek" />)).toBe(
			"DeepSeek",
		);
		expect(svgTitle(<AgentIcon agentType="pi" provider="moonshotai" />)).toBe(
			"Moonshot AI",
		);
	});

	it("falls back to the Agent glyph when provider is null/absent or unmapped", () => {
		// Pre-multi-provider Sessions carry provider=null; `zai` and custom
		// providers have no Simple Icons entry (see PROVIDER_ICONS).
		expect(svgTitle(<AgentIcon agentType="pi" provider={null} />)).toBeNull();
		expect(svgTitle(<AgentIcon agentType="pi" />)).toBeNull();
		expect(svgTitle(<AgentIcon agentType="pi" provider="zai" />)).toBeNull();
		expect(
			svgTitle(<AgentIcon agentType="openai" provider="my-custom-ollama" />),
		).toBeNull();
	});
});
