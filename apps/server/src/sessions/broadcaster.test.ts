import type { AgentStreamEvent } from "@dilna/shared";
import { describe, expect, it, vi } from "vitest";
import { SessionBroadcaster } from "./broadcaster";

/**
 * The broadcaster extracted from SessionManager (issue #149). These cover
 * the parts that used to be reachable only through a full Session +
 * worktree fixture: fan-out isolation, and the ADR-0016 §4/§5 retention
 * rules that decide what a mid-turn subscriber is replayed.
 */
describe("SessionBroadcaster", () => {
	const failed: AgentStreamEvent = {
		type: "turn_failed",
		class: "agent_crash",
		message: "boom",
	};
	const activity: AgentStreamEvent = {
		type: "turn_activity",
		phase: { kind: "requesting" },
		runningTools: [{ callId: "c1", tool: "bash", startedAt: 10 }],
		tasks: [],
		serverTime: 20,
	};
	const notice: AgentStreamEvent = {
		type: "notice",
		message: "heads up",
	};

	it("delivers only to the addressed session's subscribers", () => {
		const b = new SessionBroadcaster();
		const a = vi.fn();
		const other = vi.fn();
		b.subscribe("s1", a);
		b.subscribe("s2", other);

		b.broadcast("s1", { type: "session_status", status: "working" });

		expect(a).toHaveBeenCalledTimes(1);
		expect(other).not.toHaveBeenCalled();
	});

	it("stops delivering after unsubscribe", () => {
		const b = new SessionBroadcaster();
		const listener = vi.fn();
		const off = b.subscribe("s1", listener);
		off();

		b.broadcast("s1", { type: "session_status", status: "idle" });
		expect(listener).not.toHaveBeenCalled();
	});

	// One wedged SSE connection must not silently cut off every other tab
	// watching the same Session.
	it("keeps fanning out when one listener throws", () => {
		const b = new SessionBroadcaster();
		const healthy = vi.fn();
		b.subscribe("s1", () => {
			throw new Error("listener blew up");
		});
		b.subscribe("s1", healthy);

		expect(() =>
			b.broadcast("s1", { type: "session_status", status: "idle" }),
		).not.toThrow();
		expect(healthy).toHaveBeenCalledTimes(1);
	});

	it("retains turn_failed for a subscriber that connects after the failure", () => {
		const b = new SessionBroadcaster();
		b.broadcast("s1", failed);
		expect(b.getLastTurnFailed("s1")).toEqual(failed);
	});

	it("returns the mid-turn snapshot as notice-then-activity (ADR-0016 §4)", () => {
		const b = new SessionBroadcaster();
		b.broadcast("s1", activity);
		b.broadcast("s1", notice);
		expect(b.midTurnSnapshot("s1")).toEqual([notice, activity]);
	});

	// ADR-0016 §5: turn_activity/notice are valid only inside their turn, but
	// a turn_failed must outlive the turn it ended so a late subscriber still
	// learns why the session is crashed.
	it("clearInTurnSnapshot drops activity/notice but keeps turn_failed", () => {
		const b = new SessionBroadcaster();
		b.broadcast("s1", failed);
		b.broadcast("s1", activity);
		b.broadcast("s1", notice);

		b.clearInTurnSnapshot("s1");

		expect(b.midTurnSnapshot("s1")).toEqual([]);
		expect(b.getLastTurnFailed("s1")).toEqual(failed);
	});

	// ADR-0016 §4: a turn_failed is only "current" until the next accepted
	// turn, which is what clearTurnSnapshot (called from beginTurn) marks.
	it("clearTurnSnapshot drops everything including turn_failed", () => {
		const b = new SessionBroadcaster();
		b.broadcast("s1", failed);
		b.broadcast("s1", notice);

		b.clearTurnSnapshot("s1");

		expect(b.getLastTurnFailed("s1")).toBeUndefined();
		expect(b.midTurnSnapshot("s1")).toEqual([]);
	});

	it("retention is per session", () => {
		const b = new SessionBroadcaster();
		b.broadcast("s1", failed);
		expect(b.getLastTurnFailed("s2")).toBeUndefined();
	});

	it("global subscribers see every session's status events", () => {
		const b = new SessionBroadcaster();
		const listener = vi.fn();
		const off = b.subscribeAll(listener);

		b.broadcastGlobal({ type: "session_deleted", sessionId: "s1" });
		expect(listener).toHaveBeenCalledTimes(1);

		off();
		b.broadcastGlobal({ type: "session_deleted", sessionId: "s2" });
		expect(listener).toHaveBeenCalledTimes(1);
	});
});
