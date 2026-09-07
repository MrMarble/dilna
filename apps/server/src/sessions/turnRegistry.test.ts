import { describe, expect, it, vi } from "vitest";
import { TurnRegistry } from "./turnRegistry";

/**
 * The turn-slot registry extracted from SessionManager (issue #149). The
 * claim protocol is the load-bearing bit — ADR-0016 §2 depends on the
 * check-and-set being synchronous, which is exactly what these assert
 * without needing a real Session, worktree or agent process.
 */
describe("TurnRegistry", () => {
	it("claims a free slot and refuses a second claim for the same session", () => {
		const r = new TurnRegistry();
		expect(r.claim("s1")).not.toBeNull();
		expect(r.claim("s1")).toBeNull();
		expect(r.has("s1")).toBe(true);
	});

	it("keeps slots independent across sessions", () => {
		const r = new TurnRegistry();
		expect(r.claim("s1")).not.toBeNull();
		expect(r.claim("s2")).not.toBeNull();
	});

	it("frees the slot on release, allowing the next turn", () => {
		const r = new TurnRegistry();
		r.claim("s1");
		r.release("s1");
		expect(r.has("s1")).toBe(false);
		expect(r.claim("s1")).not.toBeNull();
	});

	it("release clears the turn's pending escalation timer", () => {
		vi.useFakeTimers();
		try {
			const r = new TurnRegistry();
			const turn = r.claim("s1");
			const fired = vi.fn();
			// biome-ignore lint/style/noNonNullAssertion: just claimed above
			turn!.escalationTimer = setTimeout(fired, 1000);

			r.release("s1");
			vi.advanceTimersByTime(5000);

			expect(fired).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("release is a no-op for a session with no claim", () => {
		const r = new TurnRegistry();
		expect(() => r.release("nope")).not.toThrow();
	});

	it("hands back a fresh, un-stopped turn on claim", () => {
		const r = new TurnRegistry();
		const turn = r.claim("s1");
		expect(turn?.stopRequested).toBe(false);
		expect(turn?.terminalized).toBe(false);
		expect(turn?.abortController.signal.aborted).toBe(false);
	});

	// ADR-0026: drain() flips the registry closed for good.
	it("reports draining only after drain() runs", async () => {
		const r = new TurnRegistry();
		expect(r.isDraining()).toBe(false);
		await r.drain(0);
		expect(r.isDraining()).toBe(true);
	});

	it("drain resolves immediately when nothing is in flight", async () => {
		const r = new TurnRegistry();
		await expect(r.drain(60_000)).resolves.toBeUndefined();
	});

	it("drain waits for a tracked turn, then resolves before the timeout", async () => {
		vi.useFakeTimers();
		try {
			const r = new TurnRegistry();
			let resolveTurn: () => void = () => {};
			r.track(
				"s1",
				new Promise<void>((resolve) => {
					resolveTurn = resolve;
				}),
			);

			const drained = r.drain(5000);
			await vi.advanceTimersByTimeAsync(1000);
			resolveTurn();
			await drained;
		} finally {
			vi.useRealTimers();
		}
	});

	it("drain gives up at the timeout when a turn never settles", async () => {
		vi.useFakeTimers();
		try {
			const r = new TurnRegistry();
			r.track("s1", new Promise<void>(() => {}));

			const drained = r.drain(5000);
			await vi.advanceTimersByTimeAsync(5000);
			await drained;
		} finally {
			vi.useRealTimers();
		}
	});

	// track() must not consume the caller's rejection — the route keeps its
	// own .catch() for logging — but it also must not surface an unhandled
	// rejection of its own.
	it("tracking a rejecting turn neither throws nor blocks drain", async () => {
		const r = new TurnRegistry();
		const rejecting = Promise.reject(new Error("turn blew up"));
		rejecting.catch(() => {});
		r.track("s1", rejecting);
		await expect(r.drain(1000)).resolves.toBeUndefined();
	});
});
