import { describe, expect, it } from "vitest";
import type { SessionStatus } from "./events";
import {
	ACTIVE_STATUSES,
	isTurnCompletion,
	notificationTag,
	TERMINAL_STATUSES,
	turnCompleteNotification,
} from "./notification";

describe("notificationTag", () => {
	it("is per-Session, so the OS replaces rather than stacks", () => {
		expect(notificationTag("abc")).toBe("dilna:abc");
	});

	it("differs between Sessions", () => {
		expect(notificationTag("a")).not.toBe(notificationTag("b"));
	});
});

describe("turnCompleteNotification", () => {
	it("composes the title, body, sessionId and tag together", () => {
		expect(
			turnCompleteNotification({ id: "s1", title: "Fix the flaky test" }),
		).toEqual({
			title: "dilna · Fix the flaky test",
			body: "Agent finished the turn.",
			sessionId: "s1",
			tag: "dilna:s1",
		});
	});

	it("tags with exactly notificationTag's output", () => {
		// The two are the *same* rule; ADR-0029's dedup depends on the push
		// payload's tag and the in-page tag matching, and both are built here.
		const payload = turnCompleteNotification({ id: "s7", title: "t" });
		expect(payload.tag).toBe(notificationTag("s7"));
	});
});

describe("isTurnCompletion", () => {
	// The negatives are what matter: the status write fires for every change,
	// so an over-broad rule notifies about turns that never ran.
	it("fires on a real turn completion", () => {
		expect(isTurnCompletion("working", "idle")).toBe(true);
	});

	it("fires for a turn that ends from starting or stopping", () => {
		expect(isTurnCompletion("starting", "idle")).toBe(true);
		expect(isTurnCompletion("stopping", "idle")).toBe(true);
	});

	it("ignores an idle→idle re-write", () => {
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

	it("does not notify on a crash — the copy would misdescribe it", () => {
		expect(isTurnCompletion("working", "crashed")).toBe(false);
	});

	it("ignores a crashed→idle recovery, which is not a completed turn", () => {
		expect(isTurnCompletion("crashed", "idle")).toBe(false);
	});

	it("is narrower than the unread-badge rule, in exactly one place", () => {
		// The badge rule counts a transition from ACTIVE into any TERMINAL
		// status as a completion, `crashed` included; the notification rule
		// fires only for `idle`. Pinning both against the same pair of sets
		// keeps that asymmetry from being re-derived (and mis-derived) on the
		// web side — where it previously existed only as a comment.
		const badgeCompletion = (from: SessionStatus, to: SessionStatus) =>
			ACTIVE_STATUSES.includes(from) && TERMINAL_STATUSES.includes(to);

		for (const from of ACTIVE_STATUSES) {
			for (const to of TERMINAL_STATUSES) {
				expect(badgeCompletion(from, to)).toBe(true);
				expect(isTurnCompletion(from, to)).toBe(to === "idle");
			}
		}
	});
});
