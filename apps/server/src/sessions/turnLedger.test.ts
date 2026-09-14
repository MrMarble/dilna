import { describe, expect, it } from "vitest";
import { TurnLedger } from "./turnLedger";

/**
 * The exactly-once persistence rule as pure sequences (issue #201). Before
 * the ledger existed this behaviour could only be reached by driving a whole
 * `runTurn` against a mocked agent; here a "transcript" is just an array of
 * distinct objects, and a round "landing" is a `recordRound` call.
 */
describe("TurnLedger", () => {
	/** Distinct objects stand in for transcript entries — the ledger tracks
	 * durability by identity, so nothing about their content matters. */
	function transcript(n: number): { id: number }[] {
		return Array.from({ length: n }, (_, id) => ({ id }));
	}

	it("offers nothing when the transcript has not grown", () => {
		const ledger = new TurnLedger(3);
		const messages = transcript(3);
		expect(ledger.settle(messages)).toEqual([]);
	});

	it("treats seeded history as already durable", () => {
		// A resumed session: the first 3 entries came out of dilna's own DB.
		const messages = transcript(5);
		const ledger = new TurnLedger(3);
		expect(ledger.settle(messages)).toEqual(messages.slice(3));
	});

	it("offers a turn's entries when the incremental path wrote none of them", () => {
		const ledger = new TurnLedger(0);
		const messages = transcript(3);
		ledger.examine(3);
		expect(ledger.settle(messages)).toEqual(messages);
	});

	it("subtracts the rounds the incremental path already wrote", () => {
		const ledger = new TurnLedger(0);
		const [a, b, c] = transcript(3) as [
			{ id: number },
			{ id: number },
			{ id: number },
		];
		ledger.examine(3);
		ledger.recordRound(a);
		ledger.recordRound(c);
		expect(ledger.settle([a, b, c])).toEqual([b]);
	});

	/**
	 * The issue #190 scenario, and the regression that survived its fix: round
	 * B's incremental write throws, A and C land. The position advances past
	 * all three (it tracks the transcript, not successes), so a slice taken
	 * from *it* would be empty and B would be lost forever. `settle` slices
	 * from the turn's start instead, and the identity set removes A and C.
	 */
	it("re-offers a failed round even after the position advanced past it", () => {
		const ledger = new TurnLedger(0);
		const [a, b, c] = transcript(3) as [
			{ id: number },
			{ id: number },
			{ id: number },
		];
		ledger.recordRound(a);
		ledger.examine(1);
		ledger.examine(1); // b's write threw — examined, not recorded.
		ledger.recordRound(c);
		ledger.examine(1);

		expect(ledger.position).toBe(3);
		expect(ledger.settle([a, b, c])).toEqual([b]);
	});

	it("writes a round exactly once across the turn's two paths", () => {
		const ledger = new TurnLedger(0);
		const messages = transcript(2);
		for (const m of messages) {
			ledger.recordRound(m);
			ledger.examine(1);
		}
		// Everything landed incrementally, so the safety net has no work.
		expect(ledger.settle(messages)).toEqual([]);
	});

	it("does not re-offer a settled turn's entries to the next turn", () => {
		const ledger = new TurnLedger(0);
		const first = transcript(2);
		ledger.examine(2);
		expect(ledger.settle(first)).toEqual(first);
		ledger.commit(first);

		// Turn two appends one entry; turn one's are behind the new turn start.
		const second = [...first, { id: 99 }];
		ledger.examine(1);
		expect(ledger.settle(second)).toEqual([{ id: 99 }]);
	});

	/**
	 * A whole-turn persistence failure: the caller never reaches `commit`, so
	 * the ledger must stay put and let the next turn's wider slice re-offer
	 * the same entries rather than skipping them once the transcript moves on.
	 */
	it("keeps offering a turn's entries when the caller never commits", () => {
		const ledger = new TurnLedger(0);
		const first = transcript(2);
		ledger.examine(2);
		expect(ledger.settle(first)).toEqual(first);
		// No commit — the write threw.

		const second = [...first, { id: 99 }];
		ledger.examine(1);
		expect(ledger.settle(second)).toEqual(second);
	});

	describe("rebase", () => {
		it("treats a compacted transcript as wholly durable", () => {
			const ledger = new TurnLedger(0);
			ledger.examine(4);

			// Compaction replaces the transcript with a summary + recent tail.
			const compacted = [{ id: 100 }, { id: 101 }];
			ledger.rebase(compacted);

			// None of it is new data to persist.
			expect(ledger.settle(compacted)).toEqual([]);
			expect(ledger.position).toBe(2);

			// And the next turn's entries are still offered normally.
			const next = [...compacted, { id: 102 }];
			ledger.examine(1);
			expect(ledger.settle(next)).toEqual([{ id: 102 }]);
		});

		it("drops durability claims for entries the rebase discarded", () => {
			const ledger = new TurnLedger(0);
			const [first, second] = transcript(2) as [{ id: number }, { id: number }];
			const messages = [first, second];
			ledger.recordRound(first);
			ledger.examine(2);

			// A compaction that happens to keep the same entry objects must not
			// let a stale claim suppress it — after a rebase it is durable by
			// *position*, which is what the empty slice below reflects.
			ledger.rebase(messages);
			expect(ledger.settle(messages)).toEqual([]);
		});
	});
});
