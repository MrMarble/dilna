/**
 * Persistence across a cold restart (idle kill / server restart): turn 2 must
 * not re-persist turn 1's closing message.
 *
 * The regression this pins: `startAgent` used to seed the turn ledger with
 * `initialMessages.length`, but pi-agent-core's `Agent` constructor unshifts
 * a synthetic system entry (system prompt + tool declarations) in front of
 * any seed that doesn't already begin with one — dilna's never does. The live
 * transcript was therefore one entry longer than the ledger believed, and the
 * next turn's safety net re-offered the seed's final entry — the previous
 * turn's closing assistant message — as a fresh-id row stamped with the *new*
 * turn's `turnId`, so the chat showed turn 1's last message again at the end
 * of turn 2 (production sessions from 2026-09-30 onward, every cold start).
 *
 * This drives the REAL `Agent` (scripted streamFn) through the exact
 * persistence bridge `runTurn` uses — `persistRoundEvent`'s incremental writes
 * plus the turn-end `persistMessagesFromAgent` safety net — so a future
 * pi-agent-core upgrade that changes constructor-time transcript mutation
 * resurfaces here instead of in production transcripts.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	dilnaMessagesToInitialState,
	piMessagesToDilna,
	piRoundToDilnaMessage,
} from "../agents/pi";
import { TurnLedger } from "./turnLedger";

const fakeModel = {
	api: "anthropic-messages",
	provider: "anthropic",
	id: "fake",
	contextWindow: 200_000,
	maxTokens: 8_192,
} as never;

function assistantText(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "fake",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { total: 0, breakdown: {} },
		},
		stopReason: "stop",
		timestamp,
	} as unknown as AssistantMessage;
}

/** streamFn yielding one scripted final message per call, pi-ai shaped. */
function scriptedStreamFn(scripts: AssistantMessage[]) {
	let call = 0;
	return () => {
		const final = scripts[call];
		call += 1;
		if (!final) throw new Error(`script exhausted at call ${call - 1}`);
		const iter = (async function* () {
			yield { type: "start", partial: final };
			yield { type: "text_delta", partial: final };
			yield { type: "done" };
		})();
		return Object.assign(iter, { result: async () => final });
	};
}

function makeAgent(seed: AgentMessage[], scripts: AssistantMessage[]) {
	return new Agent({
		initialState: {
			systemPrompt: "s",
			model: fakeModel,
			tools: [],
			messages: seed,
		},
		sessionId: "sess",
		// biome-ignore lint/suspicious/noExplicitAny: throwaway stream stub
		streamFn: scriptedStreamFn(scripts) as any,
		getApiKey: async () => "k",
	});
}

type Row = {
	id: string;
	role: string;
	turnId: string;
	createdAt: number;
	text: string;
};

/** The persistence bridge exactly as `runTurn` wires it. */
class PersistenceBridge {
	private rows: Row[] = [];

	constructor(
		private readonly agent: Agent,
		private readonly ledger: TurnLedger,
	) {}

	/** One turn: incremental subscription + turn-end safety net, as in runTurn. */
	async runTurn(prompt: string, turnId: string): Promise<void> {
		let settled = false;
		const unsubscribe = this.agent.subscribe((event) => {
			if (settled) return;
			if (event.type === "message_end" && event.message.role === "user") {
				this.ledger.examine(1);
				return;
			}
			if (event.type === "turn_end") {
				try {
					const message = piRoundToDilnaMessage(
						"sess",
						event,
						turnId,
						undefined,
					);
					if (message) this.persist(message, turnId);
					this.ledger.recordRound(event.message);
				} finally {
					this.ledger.examine(1 + event.toolResults.length);
				}
			}
		});
		await this.agent.prompt(prompt);
		settled = true;
		unsubscribe();

		const messages = this.agent.state.messages;
		const converted = piMessagesToDilna(
			"sess",
			this.ledger.settle(messages),
			turnId,
			undefined,
		);
		for (const message of converted) this.persist(message, turnId);
		this.ledger.commit(messages);
	}

	private persist(
		message: {
			id: string;
			role: string;
			turnId?: string | null;
			createdAt: number;
			parts: unknown[];
		},
		turnId: string,
	): void {
		const text = (message.parts as Array<{ type: string; text?: string }>)
			.filter((p) => p.type === "text")
			.map((p) => p.text ?? "")
			.join("\n");
		this.rows.push({
			id: message.id,
			role: message.role,
			turnId: message.turnId ?? turnId,
			createdAt: message.createdAt,
			text,
		});
	}

	/** The rows, as `getMessages` would return them (seq order). */
	get persisted(): Row[] {
		return this.rows;
	}
}

/** Rows a fresh spawn re-seeds from, mirroring startAgent's history walk. */
function seedFrom(rows: Row[]): { seed: AgentMessage[]; length: number } {
	const seed = dilnaMessagesToInitialState(
		rows.map((r) => ({
			id: r.id,
			sessionId: "sess",
			role: r.role as "assistant",
			parts: [{ type: "text", text: r.text }] as never,
			turnId: r.turnId,
			createdAt: r.createdAt,
		})),
	);
	return { seed, length: seed.length };
}

describe("persistence across a cold restart", () => {
	it("does not re-persist the previous turn's final message", async () => {
		// Turn 1 on a fresh agent (seed empty), like a session's first turn.
		const first = makeAgent([], [assistantText("FINAL ONE", 1_000)]);
		const bridgeOne = new PersistenceBridge(first, new TurnLedger(0));
		await bridgeOne.runTurn("turn one", "turn-1");

		// Cold restart: seed rebuilt from persisted rows, fresh ledger — the
		// ledger seeded the way `startAgent` seeds it, from the Agent's own
		// (post-construction) transcript length.
		const { seed } = seedFrom(bridgeOne.persisted);
		const second = makeAgent(seed, [assistantText("TURN TWO REPLY", 2_000)]);
		// The constructor's system-entry unshift is exactly why the seed count
		// must be read off the constructed transcript, never the seed array.
		expect(second.state.messages.length).toBe(seed.length + 1);
		const bridgeTwo = new PersistenceBridge(
			second,
			new TurnLedger(second.state.messages.length),
		);
		await bridgeTwo.runTurn("turn two", "turn-2");

		const all = [...bridgeOne.persisted, ...bridgeTwo.persisted];
		expect(all.map((r) => [r.text, r.turnId])).toEqual([
			["FINAL ONE", "turn-1"],
			["TURN TWO REPLY", "turn-2"],
		]);
	});

	it("does not duplicate on consecutive warm turns either", async () => {
		const agent = makeAgent(
			[],
			[
				assistantText("FINAL ONE", 1_000),
				assistantText("TURN TWO REPLY", 2_000),
			],
		);
		const bridge = new PersistenceBridge(agent, new TurnLedger(0));
		await bridge.runTurn("turn one", "turn-1");
		await bridge.runTurn("turn two", "turn-2");

		expect(bridge.persisted.map((r) => [r.text, r.turnId])).toEqual([
			["FINAL ONE", "turn-1"],
			["TURN TWO REPLY", "turn-2"],
		]);
	});
});
