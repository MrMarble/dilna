/**
 * Cache-simulating fake provider (issue #271's measurement instrument).
 *
 * Loaded into the dilna server process via
 * `NODE_OPTIONS="--import <this-file-as-url>"`. Two jobs:
 *
 * 1. Registers a module hook stubbing `@anthropic-ai/sandbox-runtime` — the
 *    sandbox proxy/Socket machinery is irrelevant here (the provider is
 *    faked in-process, the only tool exercised reads the filesystem
 *    directly) and its mux listener can't bind unix sockets in the
 *    measurement container anyway.
 * 2. Replaces globalThis.fetch and answers Anthropic-messages API calls
 *    with canned SSE — computing the cache split the way a real
 *    prefix-caching provider would, **from the requests dilna actually
 *    sends**:
 *
 *    - For every request it hashes each cumulative message boundary
 *      (system + messages[0..i], i over every message including the
 *      trailing user turn — a provider caches the whole request for the
 *      next one).
 *    - cache_read  = tokens of the longest boundary previously seen.
 *    - cache_write = tokens from there to the end of the request.
 *
 *    A prefix that is byte-identical across a cold start therefore reads; a
 *    changed system prompt (or re-ordered history) misses and re-writes.
 *    The boundary table and the per-request log survive the server process
 *    (persisted under the scratch data dir), because a real provider's
 *    cache outlives dilna's process — that is exactly the mechanism under
 *    test.
 *
 * Token counts are the honest chars/4 estimate of the exact bytes on the
 * wire — the numbers measure prefix *identity*, not tokenizer accuracy.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

register("./cache-spy-hooks.mjs", import.meta.url);

const STATE_FILE =
	process.env.CACHE_SPY_STATE ||
	path.join(process.cwd(), "cache-spy-state.json");

// sha256 over the canonical content boundary; 32 hex chars are plenty for
// a fixture-run table.
function hashText(text) {
	return crypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
}

// chars/4 — the same flat estimate pi-agent-core's estimator uses.
const estTokens = (text) => Math.ceil((text || "").length / 4);

function messageText(content) {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((b) => {
				if (typeof b === "string") return b;
				if (b.type === "text") return b.text;
				if (b.type === "tool_result") return messageText(b.content ?? "");
				if (b.type === "tool_use") return JSON.stringify(b.input ?? {});
				if (b.type === "toolCall") return JSON.stringify(b.arguments ?? {});
				return JSON.stringify(b);
			})
			.join("");
	}
	return JSON.stringify(content ?? "");
}

let state;
if (fs.existsSync(STATE_FILE)) {
	state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
} else {
	state = { boundaries: {}, log: [] };
}
function saveState() {
	fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

function cacheSplit(body) {
	const system = body.system
		? (Array.isArray(body.system) ? body.system : [body.system])
				.map((b) => (typeof b === "string" ? b : (b.text ?? "")))
				.join("")
		: "";
	// pi-agent-core carries zero-content internal `system` entries in its
	// message array at positions that differ between a live turn and a
	// replayed one — they never reach the wire as messages (system content
	// rides the `system` param), so they are dropped from the cache stream.
	const messages = (body.messages ?? []).filter(
		(m) => m.role !== "system" && messageText(m.content).length > 0,
	);
	// Boundaries are keyed on the concatenated CONTENT stream, not the
	// message objects: a provider's cache matches bytes of content, and the
	// same content can be split across messages differently between a live
	// transcript and a replayed one.
	const boundaries = [];
	let text = system;
	let tokens = estTokens(system);
	if (messages.length === 0) {
		boundaries.push({ key: hashText(text), tokens });
	}
	for (const m of messages) {
		const part = messageText(m.content);
		text += `\u0000${part}`;
		tokens += estTokens(part);
		boundaries.push({ key: hashText(text), tokens });
	}

	let readTokens = 0;
	let matched = -1;
	for (let i = 0; i < boundaries.length; i++) {
		if (state.boundaries[boundaries[i].key] !== undefined) matched = i;
	}
	if (matched >= 0) readTokens = boundaries[matched].tokens;
	const total = tokens;
	const writeTokens = Math.max(0, total - readTokens);

	for (const b of boundaries) state.boundaries[b.key] = true;
	const sys = crypto
		.createHash("sha256")
		.update(system)
		.digest("hex")
		.slice(0, 12);
	return { readTokens, writeTokens, total, sys, msgs: messages.length };
}

function sse(events) {
	const body = events
		.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n`)
		.join("\n");
	return new Response(body + "\n", {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function textReply(body, text, { log = true } = {}) {
	const split = cacheSplit(body);
	const inputTokens = split.total;
	if (log)
		state.log.push({
			t: Date.now(),
			kind: "turn",
			read: split.readTokens,
			write: split.writeTokens,
			total: split.total,
			sys: split.sys,
			msgs: split.msgs,
		});
	saveState();

	const events = [
		{
			event: "message_start",
			data: {
				type: "message_start",
				message: {
					id: `msg_${state.log.length}`,
					role: "assistant",
					model: body.model,
					content: [],
					usage: {
						input_tokens: inputTokens,
						output_tokens: 0,
						cache_read_input_tokens: split.readTokens,
						cache_creation_input_tokens: split.writeTokens,
					},
				},
			},
		},
		{
			event: "content_block_start",
			data: {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			},
		},
		{
			event: "content_block_delta",
			data: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text },
			},
		},
		{
			event: "content_block_stop",
			data: { type: "content_block_stop", index: 0 },
		},
		{
			event: "message_delta",
			data: {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { output_tokens: estTokens(text) },
			},
		},
		{ event: "message_stop", data: { type: "message_stop" } },
	];
	return sse(events);
}

function toolReply(body, toolName, toolInput) {
	const split = cacheSplit(body);
	state.log.push({
		t: Date.now(),
		kind: "turn",
		read: split.readTokens,
		write: split.writeTokens,
		total: split.total,
		sys: split.sys,
		msgs: split.msgs,
	});
	saveState();

	const argsJson = JSON.stringify(toolInput);
	return sse([
		{
			event: "message_start",
			data: {
				type: "message_start",
				message: {
					id: `msg_${state.log.length}`,
					role: "assistant",
					model: body.model,
					content: [],
					usage: {
						input_tokens: split.total,
						output_tokens: 0,
						cache_read_input_tokens: split.readTokens,
						cache_creation_input_tokens: split.writeTokens,
					},
				},
			},
		},
		{
			event: "content_block_start",
			data: {
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: `toolu_${state.log.length}`,
					name: toolName,
					input: {},
				},
			},
		},
		{
			event: "content_block_delta",
			data: {
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: argsJson },
			},
		},
		{
			event: "content_block_stop",
			data: { type: "content_block_stop", index: 0 },
		},
		{
			event: "message_delta",
			data: {
				type: "message_delta",
				delta: { stop_reason: "tool_use" },
				usage: { output_tokens: 10 },
			},
		},
		{ event: "message_stop", data: { type: "message_stop" } },
	]);
}

const DEBUG = process.env.CACHE_SPY_DEBUG === "1";
function dbg(obj) {
	if (DEBUG)
		fs.appendFileSync(
			process.env.CACHE_SPY_DEBUG_FILE ||
				path.join(STATE_FILE, "..", "spy-debug.log"),
			JSON.stringify(obj) + "\n",
		);
}

globalThis.fetch = async function patchedFetch(input, init) {
	const url = typeof input === "string" ? input : input.url;
	const body = init?.body ? JSON.parse(init.body) : {};

	dbg({
		url,
		method: init?.method,
		roles: (body.messages ?? []).map((m) => ({
			role: m.role,
			len: messageText(m.content).length,
			head: messageText(m.content).slice(0, 60),
		})),
	});
	if (url.includes("/v1/messages")) {
		const systemText =
			typeof body.system === "string"
				? body.system
				: (body.system ?? []).map((b) => b.text ?? "").join("");
		// The title-derivation call runs with no tools and a distinct system
		// prompt; answer it with a fixed title and DON'T pollute the prefix
		// table — it is a separate one-shot request, not the Session prefix.
		const isTitleCall = !body.tools && systemText.includes("session titles");
		if (isTitleCall) {
			saveState();
			return textReply(body, "Measured Session", { log: false });
		}
		// Default script: reply with the text the harness asked for. The
		// harness can request a tool call by naming it in the last user
		// message: `@@tool:<name>:<json-input>`.
		const lastUser = [...(body.messages ?? [])]
			.reverse()
			.find((m) => m.role === "user");
		const text = messageText(lastUser?.content ?? "");
		const toolMatch = text.match(/@@tool:([a-z_]+):(.+)$/s);
		dbg({ lastUserText: text.slice(0, 200), toolMatch: Boolean(toolMatch) });
		if (toolMatch) {
			return toolReply(body, toolMatch[1], JSON.parse(toolMatch[2]));
		}
		return textReply(body, `Done: ${text.slice(0, 80)}`);
	}

	return realFetch(input, init);
};
