/**
 * Per-turn stop/abort state (ADR-0016 §3), claimed synchronously by
 * `SessionManager.beginTurn` — before `ensureStarted` even runs — so a Stop
 * request lands correctly whether the turn is still spawning (`starting`) or
 * already `working`. Kept independent of `ActiveAgent` (which doesn't exist
 * until a cold spawn finishes): the registry, not the agent handle, is the
 * single source of truth for "is a turn in flight" and for the 202-vs-409
 * accept race.
 */
export type Turn = {
	abortController: AbortController;
	/** Idempotency guard: a repeated Stop call while already stopping is
	 * absorbed without restarting `escalationTimer`'s clock. */
	stopRequested: boolean;
	escalationTimer: NodeJS.Timeout | null;
	/** Set once a `turn_failed` has already routed this turn to its terminal
	 * status (stop-timeout escalation, or a crash mid-turn) — `runTurn`'s own
	 * end-of-turn status transition is then redundant and skipped, since a
	 * turn may only reach one terminal status. */
	terminalized: boolean;
};

/**
 * Turn-slot bookkeeping and graceful-shutdown tracking, extracted from
 * `SessionManager` (issue #149). Two closely-related concerns live together
 * here because they answer the same question at different granularities:
 * `turnsInProgress` is "may this session accept a turn right now", and
 * `runningTurns`/`draining` is "may this *process* accept a turn, and what
 * must it wait for before exiting" (ADR-0026).
 *
 * The claim protocol is the load-bearing part: {@link claim} performs its
 * check-and-set synchronously, with no `await` in between, which is what
 * makes the pre-202 409 the only duplicate-send surface (ADR-0016 §2). Any
 * refactor that makes claiming async reintroduces the double-accept race
 * this shape exists to close.
 */
export class TurnRegistry {
	/** Session id -> in-flight turn's stop/abort state. */
	private turns = new Map<string, Turn>();
	/** Session id -> the in-flight `runTurn` promise a caller kicked off after
	 * `claim` took the slot. Entries remove themselves once their turn
	 * settles. */
	private runningTurns = new Map<string, Promise<void>>();
	/** Once true, every new claim is refused so a draining process stops
	 * accepting work it won't have time to finish. Never reset — a drained
	 * registry is on its way to `process.exit`, not a state to recover
	 * from. */
	private draining = false;

	isDraining(): boolean {
		return this.draining;
	}

	/** True if the session currently has a turn in flight — see the class
	 * doc for why this, and not the agent handle, is the source of truth. */
	has(id: string): boolean {
		return this.turns.has(id);
	}

	get(id: string): Turn | undefined {
		return this.turns.get(id);
	}

	/**
	 * Take the session's turn slot. Synchronous and non-blocking: returns
	 * `null` if the slot is already taken (the caller maps that to 409), and
	 * otherwise installs and returns the fresh {@link Turn}. Callers must
	 * check `isDraining()` first — a draining process refuses claims for a
	 * different reason and with a different status (503).
	 */
	claim(id: string): Turn | null {
		if (this.turns.has(id)) return null;
		const turn: Turn = {
			abortController: new AbortController(),
			stopRequested: false,
			escalationTimer: null,
			terminalized: false,
		};
		this.turns.set(id, turn);
		return turn;
	}

	/** Release the session's turn slot and clear the turn's escalation timer.
	 * Called from `runTurn`'s outermost `finally`, so it runs on every exit
	 * path including a thrown one. */
	release(id: string): void {
		const turn = this.turns.get(id);
		if (turn?.escalationTimer) clearTimeout(turn.escalationTimer);
		this.turns.delete(id);
	}

	/**
	 * Register an in-flight `runTurn` call so {@link drain} can wait on it.
	 * Every `runTurn(...)` call site (routes/sessions.ts, and the
	 * orchestrator's `createChildSession`) must call this with the promise it
	 * got back — `runTurn` doesn't register itself, since it has no way to
	 * refer to its own outer promise from inside its own body. Callers keep
	 * their own `.catch()` for logging; this only tracks completion, it
	 * doesn't consume the promise's rejection.
	 */
	track(id: string, promise: Promise<void>): void {
		this.runningTurns.set(id, promise);
		promise
			.catch(() => {
				// Swallowed here — the caller's own `.catch()` (routes/sessions.ts
				// or the orchestrator path) already logs it. This handler exists
				// only so an unawaited rejection inside `finally` below doesn't
				// surface as an unhandled rejection.
			})
			.finally(() => {
				if (this.runningTurns.get(id) === promise) {
					this.runningTurns.delete(id);
				}
			});
	}

	/**
	 * Graceful shutdown (ADR-0026): stop accepting new turns and wait, up to
	 * `timeoutMs`, for every currently in-flight turn to reach its own
	 * `finally` in `runTurn` and persist. Only helps against a plannable
	 * termination signal (`SIGTERM`) — a hard `SIGKILL` (e.g. an OOM kill)
	 * gives nothing running in-process a chance to run this at all. A turn
	 * still running past `timeoutMs` is abandoned, not aborted — `index.ts`
	 * proceeds to close the server and exit either way; incremental
	 * persistence (ADR-0026) is what bounds the resulting loss, not this.
	 */
	async drain(timeoutMs: number): Promise<void> {
		this.draining = true;
		const inFlight = [...this.runningTurns.values()];
		if (inFlight.length === 0) return;
		console.log(
			`[sessions] draining ${inFlight.length} in-flight turn(s), up to ${timeoutMs / 1000}s...`,
		);
		await Promise.race([
			Promise.allSettled(inFlight),
			new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
		]);
	}
}
