import { createHash } from "node:crypto";
import {
	applyToolOutputPolicy,
	TOOL_OUTPUT_POLICY,
	type ToolTrimContext,
	toolOutputIdentity,
} from "@dilna/shared";
import { describe, expect, it } from "vitest";

/** The server's hasher — sync sha256 hex, same as context.ts passes in. */
const sha256 = (text: string) =>
	createHash("sha256").update(text).digest("hex");

const BIG_READ = Array.from(
	{ length: 3_000 },
	(_, i) => `line ${i}: import { something } from "../somewhere";`,
).join("\n");

describe("applyToolOutputPolicy — no-ops by design", () => {
	it("leaves codegraph and task outputs verbatim (they already summarise)", () => {
		for (const tool of ["codegraph", "task"]) {
			expect(
				applyToolOutputPolicy(tool, {}, BIG_READ, sha256, ctx()),
			).toBeNull();
		}
	});

	it("leaves tools without a policy verbatim, even huge ones", () => {
		for (const tool of [
			"write",
			"edit",
			"ls",
			"fetch",
			"dilna_publish_artefact",
		]) {
			expect(
				applyToolOutputPolicy(tool, {}, BIG_READ, sha256, ctx()),
			).toBeNull();
		}
	});

	it("leaves small outputs verbatim — markers would cost more than they save", () => {
		expect(
			applyToolOutputPolicy("read", { path: "a.ts" }, "tiny", sha256, ctx()),
		).toBeNull();
	});
});

describe("applyToolOutputPolicy — read", () => {
	it("reduces a huge read to head + tail + marker carrying path, line range and hash", () => {
		const trimmed = applyToolOutputPolicy(
			"read",
			{ path: "src/big.ts" },
			BIG_READ,
			sha256,
			ctx(),
		);
		expect(trimmed).not.toBeNull();
		const seeded = trimmed?.seeded ?? "";
		// Head and tail survive.
		expect(seeded).toContain("line 0:");
		expect(seeded).toContain(`line 2999:`);
		// The middle does not.
		expect(seeded).not.toContain("line 1500:");
		// The marker carries path, the line range, and the content hash.
		expect(seeded).toContain("read of src/big.ts");
		expect(seeded).toContain(`of 3000`);
		expect(seeded).toContain(sha256(BIG_READ).slice(0, 16));
		// The re-read note: the agent can verify without re-reading.
		expect(seeded).toContain("returns the same bytes");
		expect(trimmed?.seeded.length).toBeLessThan(BIG_READ.length / 2);
	});

	it("recognises a re-read of the same path and hash as a no-op", () => {
		const state = ctx();
		applyToolOutputPolicy(
			"read",
			{ path: "src/big.ts" },
			BIG_READ,
			sha256,
			state,
		);
		const again = applyToolOutputPolicy(
			"read",
			{ path: "src/big.ts" },
			BIG_READ,
			sha256,
			state,
		);
		expect(again?.seeded).toContain("identical result to turn 1");
		expect(again?.seeded).toContain("re-running it is a no-op");
		// The whole point: the repeated content is gone from the seed.
		expect(again?.seeded).not.toContain("line 0:");
		// Even a tiny repeat is caught — dedup does not care about size.
		const small = "same bytes as before";
		applyToolOutputPolicy("read", { path: "b.ts" }, small, sha256, state);
		expect(
			applyToolOutputPolicy("read", { path: "b.ts" }, small, sha256, state)
				?.seeded,
		).toContain("identical result to");
	});

	it("does not dedup a read whose content changed", () => {
		const state = ctx();
		applyToolOutputPolicy(
			"read",
			{ path: "src/big.ts" },
			BIG_READ,
			sha256,
			state,
		);
		const changed = BIG_READ.replace("line 7:", "line 7 EDITED:");
		const second = applyToolOutputPolicy(
			"read",
			{ path: "src/big.ts" },
			changed,
			sha256,
			state,
		);
		// Not a dedup marker — it is a fresh head/tail trim.
		expect(second?.seeded).not.toContain("identical result to");
		expect(second?.seeded).toContain("line 0:");
	});
});

describe("applyToolOutputPolicy — grep / find", () => {
	const GREP_OUT = Array.from(
		{ length: 250 },
		(_, i) => `src/f${i}.ts:${i}: match here`,
	).join("\n");

	it("dedups a repeated search by result-set identity", () => {
		const input = { pattern: "match here", path: "src" };
		const state = ctx();
		applyToolOutputPolicy("grep", input, GREP_OUT, sha256, state);
		expect(
			applyToolOutputPolicy("grep", input, GREP_OUT, sha256, state)?.seeded,
		).toContain("identical result to turn 1");
		expect(
			applyToolOutputPolicy("grep", input, GREP_OUT, sha256, state)?.seeded,
		).toContain("grep match here in src");
	});

	it("keeps a changed result set — the search found something new", () => {
		const state = ctx();
		const input = { pattern: "match here", path: "src" };
		applyToolOutputPolicy("grep", input, GREP_OUT, sha256, state);
		const changed = GREP_OUT.replace("src/f0.ts:0", "src/f0.ts:1");
		// A changed result set is not a repeat: grep has no size trim, so it
		// seeds verbatim (null from the policy).
		const second = applyToolOutputPolicy("grep", input, changed, sha256, state);
		expect(second).toBeNull();
	});

	it("find dedups on pattern+path+result set", () => {
		const input = { pattern: "*.ts", path: "src" };
		const state = ctx();
		applyToolOutputPolicy("find", input, GREP_OUT, sha256, state);
		expect(
			applyToolOutputPolicy("find", input, GREP_OUT, sha256, state)?.seeded,
		).toContain("identical result to turn 1");
	});
});

describe("applyToolOutputPolicy — bash", () => {
	const BASH_OUT = [
		...Array.from({ length: 300 }, (_, i) => `progress ${i}/300 ok`),
		"ERROR: deploy step 300 failed: permission denied",
		...Array.from({ length: 300 }, (_, i) => `cleanup ${i}/300 ok`),
	].join("\n");

	it("keeps the last N lines and error-pattern lines, drops the middle", () => {
		const trimmed = applyToolOutputPolicy(
			"bash",
			{ command: "deploy" },
			BASH_OUT,
			sha256,
			ctx(),
		);
		expect(trimmed).not.toBeNull();
		const seeded = trimmed?.seeded ?? "";
		// Tail survives.
		expect(seeded).toContain("cleanup 299/300 ok");
		// Error lines from the dropped middle survive.
		expect(seeded).toContain(
			"ERROR: deploy step 300 failed: permission denied",
		);
		// The bulk does not.
		expect(seeded).not.toContain("progress 5/300 ok");
		expect(seeded).toContain("content sha256");
	});

	it("leaves a small bash result verbatim", () => {
		expect(
			applyToolOutputPolicy(
				"bash",
				{ command: "ls" },
				"file1\nfile2",
				sha256,
				ctx(),
			),
		).toBeNull();
	});
});

describe("toolOutputIdentity", () => {
	it("keys read by path and content hash", () => {
		const a = toolOutputIdentity("read", { path: "a.ts" }, "x", sha256);
		const b = toolOutputIdentity("read", { path: "a.ts" }, "x", sha256);
		const c = toolOutputIdentity("read", { path: "b.ts" }, "x", sha256);
		const d = toolOutputIdentity("read", { path: "a.ts" }, "y", sha256);
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a).not.toBe(d);
	});

	it("is null for tools without repeatable results", () => {
		expect(
			toolOutputIdentity("bash", { command: "ls" }, "x", sha256),
		).toBeNull();
		expect(toolOutputIdentity("codegraph", {}, "x", sha256)).toBeNull();
	});
});

describe("policy thresholds", () => {
	it("trips on chars even when lines are few (a long minified line)", () => {
		const oneLongLine = "x".repeat(TOOL_OUTPUT_POLICY.minChars + 1);
		// read of a single 6001-char line: size-trips, but head/tail trim of
		// one line is meaningless — the dedup/identity path still recorded it,
		// and the read trim keeps head+tail (the whole thing here, 1 line each
		// side is the same content) — so the policy returns a trim only when
		// it actually removes something. One line cannot be reduced: null.
		const state = ctx();
		expect(
			applyToolOutputPolicy(
				"read",
				{ path: "m.ts" },
				oneLongLine,
				sha256,
				state,
			),
		).toBeNull();
	});
});

function ctx(): ToolTrimContext {
	return { turnLabel: "turn 1", seen: new Map() };
}
