import type { ToolName } from "@dilna/shared";
import { TOOL_NAMES } from "@dilna/shared";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { toToolDeclaration } from "@earendil-works/pi-ai";
import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { createPublishArtefactTool } from "./artefactTools";
import { createSendImageTool } from "./imageTools";
import {
	createReadRepoMemoryTool,
	createReadSkillTool,
	createUpdateRepoMemoryTool,
} from "./pi";
import { charsPerTokenFor } from "./providerConfig";
import { createTaskTool } from "./taskTool";
import { createWebFetchTool } from "./webFetchTool";

/**
 * Measured schema weight of every built-in tool (issue #296, finding T —
 * unused built-in tools).
 *
 * dilna registers the same tool set on every ordinary Session (see
 * `startPi`), and the provider bills those tools' declarations — name,
 * description, JSON schema — as prompt tokens on *every* turn, used or not.
 * Finding T turns that constant cost into an estimated waste for tools the
 * per-turn facts (issue #292) show were never (or barely) called. The weight
 * side of that ratio is measured here, not guessed: each tool is rebuilt
 * through the exact factory `startPi` calls (dilna's own factories are
 * exported from `agents/pi.ts` for this) and serialized with pi-ai's own
 * `toToolDeclaration` — the canonical wire shape, the same one
 * `declarationsEqual` compares transcripts with. A future edit to any tool's
 * description or schema therefore moves the finding's numbers automatically;
 * there is no static weight table to drift.
 *
 * Construction is inert: every factory only closes over its deps (the pi
 * built-ins don't touch the filesystem until `execute`, verified against the
 * installed pi-coding-agent 0.87 sources), so the dummy paths/ids/callbacks
 * below are never exercised — only the declaration fields are read.
 *
 * Two tool groups are deliberately outside this universe:
 * - `codegraph`: registered per-Session only when the Worktree has a
 *   `.codegraph/` index, which `usage_events` doesn't record — claiming its
 *   schema rode in turns we cannot verify would overstate the waste (and its
 *   absence from a finding would understate). Not in `TOOL_NAMES`, and
 *   finding T's universe is exactly `TOOL_NAMES`.
 * - the orchestrator's `dilna_*` tools: a different toolset on a different
 *   Session kind, whose turns finding T excludes outright (see
 *   `burnFindings.ts`).
 */

/** Whether a built-in tool is part of dilna's irreducible shape or an
 * addition a given use could plausibly live without. Structural tools get
 * informational-only findings (an Agent without them isn't dilna — the
 * issue's example: bash/task); situational tools get "consider disabling"
 * findings. There is deliberately no one-click disable for either: dilna has
 * no tool-enablement config, so finding T is advisory, unlike finding K's
 * skill disable (issue #295). */
export type ToolBurnClass = "structural" | "situational";

/** The pi coding loop is the Agent (read through bash), the issue names
 * `task` outright, and `read_skill` is how progressive disclosure (#60)
 * delivers skills at all — without it the system prompt's SKILLS section is
 * dead text. The rest are dilna additions a use case can plausibly never
 * touch. */
export const TOOL_BURN_CLASSIFICATION: Record<ToolName, ToolBurnClass> = {
	read: "structural",
	write: "structural",
	edit: "structural",
	grep: "structural",
	find: "structural",
	ls: "structural",
	bash: "structural",
	read_repo_memory: "situational",
	update_repo_memory: "situational",
	read_skill: "structural",
	fetch: "situational",
	task: "structural",
	dilna_publish_artefact: "situational",
	dilna_send_image: "situational",
};

const UNUSED_WORKTREE = "/dilna-schema-weight/unused";

/** Rebuild every built-in tool through the same factories `startPi` uses,
 * with inert deps. `createTaskTool`'s `model` is only read when a subagent
 * actually runs, which never happens here — hence the cast. */
function buildBuiltInTools(): Record<
	ToolName,
	// biome-ignore lint/suspicious/noExplicitAny: AgentTool<any> is the library's own alias for a type-erased tool (pi-coding-agent's `Tool` type)
	AgentTool<any>
> {
	const task = createTaskTool({
		worktreePath: UNUSED_WORKTREE,
		sessionId: "dilna-schema-weight",
		extraReadablePaths: [],
		model: {} as unknown as Model<Api>,
		lookupModel: () => undefined,
		getApiKey: async () => undefined,
		onTasksChanged: () => {},
		onUsage: () => {},
	});

	const tools = [
		createReadTool(UNUSED_WORKTREE),
		createWriteTool(UNUSED_WORKTREE),
		createEditTool(UNUSED_WORKTREE),
		createGrepTool(UNUSED_WORKTREE),
		createFindTool(UNUSED_WORKTREE),
		createLsTool(UNUSED_WORKTREE),
		// No `operations` override: the declaration (name/description/parameters)
		// is identical whether the sandboxed or local operations are wired —
		// operations only affect `execute`, which is never called here.
		createBashTool(UNUSED_WORKTREE),
		createReadRepoMemoryTool("dilna-schema-weight"),
		createUpdateRepoMemoryTool("dilna-schema-weight"),
		// An empty skill list is exactly the state the declaration doesn't
		// depend on (the schema/description are static; only `execute` reads
		// the list).
		createReadSkillTool([]),
		// `createWebFetchTool`'s options are test-only injection; production
		// takes the default, same as `startPi`.
		createWebFetchTool(),
		task.tool,
		createPublishArtefactTool({
			sessionId: "dilna-schema-weight",
			worktreePath: UNUSED_WORKTREE,
			onPublished: () => {},
		}),
		createSendImageTool({
			sessionId: "dilna-schema-weight",
			worktreePath: UNUSED_WORKTREE,
			onImageSent: () => {},
		}),
	];

	const byName = {} as Record<
		ToolName,
		// biome-ignore lint/suspicious/noExplicitAny: see the return type above
		AgentTool<any>
	>;
	for (const tool of tools) {
		if (!isBuiltInName(tool.name)) continue;
		byName[tool.name] = tool;
	}
	return byName;
}

function isBuiltInName(name: string): name is ToolName {
	return (TOOL_NAMES as readonly string[]).includes(name);
}

let cachedChars: Record<ToolName, number> | null = null;

/**
 * Serialized wire size of each built-in tool's declaration, in characters —
 * `toToolDeclaration` is pi-ai's own canonical projection of a tool onto the
 * transcript (name + description + JSON-round-tripped parameters), so this
 * is the payload the provider bills the prompt for, up to the provider's
 * tokenizer. Memoized: the declarations are static for a build.
 */
export function builtInToolSchemaChars(): Record<ToolName, number> {
	if (cachedChars) return cachedChars;
	const tools = buildBuiltInTools();
	const chars = {} as Record<ToolName, number>;
	for (const name of TOOL_NAMES) {
		const tool = tools[name];
		if (!tool) {
			// TOOL_NAMES and startPi's registrations are kept in sync by the
			// shared union's own tests; if they ever drift, measuring nothing
			// here would silently zero the finding — fail loudly instead.
			throw new Error(
				`built-in tool "${name}" could not be constructed for schema weighing`,
			);
		}
		chars[name] = JSON.stringify(toToolDeclaration(tool)).length;
	}
	cachedChars = chars;
	return chars;
}

/**
 * The tool's schema weight for one turn's provider, in estimated tokens:
 * the measured characters over the same per-provider `charsPerToken`
 * calibration the context estimator uses (`providerConfig.ts`) — a tool
 * schema is code-dense JSON plus English prose, exactly what that constant
 * was measured on. `Math.ceil` like the library's own estimator.
 */
export function toolSchemaTokens(name: ToolName, provider: string): number {
	const chars = builtInToolSchemaChars()[name];
	return Math.ceil(chars / charsPerTokenFor(provider));
}
