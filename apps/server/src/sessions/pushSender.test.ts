import { describe, expect, it } from "vitest";
import { isTurnCompletion } from "./pushSender";

/**
 * The server-side completion rule (ADR-0029). This mirrors the client rule in
 * `useSessionNotifications`, and the cases that matter are the *negatives* —
 * `transitionStatus` runs on every status write, so an over-broad rule would
 * push a notification for turns that never happened.
 */
describe("isTurnCompletion", () => {
	it("fires on a real turn completion", () => {
		expect(isTurnCompletion("working", "idle")).toBe(true);
	});

	it("fires for a turn that ends from starting or stopping", () => {
		expect(isTurnCompletion("starting", "idle")).toBe(true);
		expect(isTurnCompletion("stopping", "idle")).toBe(true);
	});

	it("ignores an idle→idle re-write (a stop on an already-idle session)", () => {
		expect(isTurnCompletion("idle", "idle")).toBe(false);
	});

	it("ignores a first-observation transition with no previous status", () => {
		expect(isTurnCompletion(undefined, "idle")).toBe(false);
	});

	it("ignores non-terminal transitions", () => {
		expect(isTurnCompletion("idle", "working")).toBe(false);
		expect(isTurnCompletion("working", "stopping")).toBe(false);
		expect(isTurnCompletion("starting", "working")).toBe(false);
	});

	it("does not notify on a crash — the sidebar already surfaces it, and the copy would be wrong", () => {
		expect(isTurnCompletion("working", "crashed")).toBe(false);
	});

	it("ignores a crashed→idle recovery, which is not a completed turn", () => {
		expect(isTurnCompletion("crashed", "idle")).toBe(false);
	});
});
