/**
 * What of a turn is already durable.
 *
 * A turn's rows reach the DB by two paths that overlap on purpose
 * (ADR-0026): an *incremental* one that writes each round the moment it
 * completes, and a turn-end *safety net* that writes whatever the first path
 * missed. Getting "exactly once" out of two writers requires correlating two
 * different kinds of fact, and this module owns both:
 *
 * - a **position** in the agent's transcript (`handle.agent.state.messages`)
 *   — how far dilna has *examined*; the safety net's slice starts here.
 * - an **identity set** of the entries the incremental path actually *wrote*
 *   — which of the examined entries are durable.
 *
 * The two are not interchangeable, and issue #190 is what happens when one
 * field tries to be both. A position is a single high-water mark, so a round
 * whose write threw pins it behind *every* later round; advance it anyway and
 * it ends up pointing past the failed round instead of at it. The turn-end
 * slice then begins mid-transcript — re-offering a round that already landed
 * (a duplicate row, since the two converters mint fresh ids and
 * `persistConverted`'s dedup is id-based) while never re-offering the one
 * that didn't (silent loss). The rule is therefore: the position advances on
 * *every* entry seen, success or failure, and durability is recorded
 * separately by identity.
 *
 * That alone still loses a round, which is why {@link settle} slices from a
 * *turn-start* mark rather than from the position. #190's fix advanced the
 * position unconditionally, so at turn end it equals the transcript length
 * and `slice(position)` is empty — fine when every round landed, but a round
 * whose incremental write threw is then never re-offered either. (The test
 * that was meant to cover this passed a literal `0` for the slice start
 * instead of the position production actually holds, so the gap went
 * unnoticed.) Slicing from the turn's start re-offers the whole turn and
 * lets the identity set subtract the rounds that landed, which is precisely
 * the split this module exists to keep straight.
 *
 * Keeping those two fields private is the point of the module. They were
 * mutated from four sites across `manager.ts` and the invariant was carried
 * by doc comments at each; here it is carried by the four methods below,
 * which are the only way to move either field.
 */
export class TurnLedger {
	/**
	 * How far into the transcript dilna has examined. A position, not a
	 * success counter — see the class doc.
	 */
	private examined: number;
	/**
	 * Where the in-flight turn's own entries begin — the mark {@link settle}
	 * slices from, so a round whose incremental write failed is still re-offered
	 * even once {@link examine} has advanced the position past it.
	 *
	 * Equal to {@link examined} between turns; pinned at the turn's first entry
	 * while one is in flight. {@link commit} and {@link rebase} bring the two
	 * back together.
	 */
	private turnStart: number;
	/**
	 * The transcript entries the incremental path has durably written, held by
	 * object identity: these are the very entry objects sitting in
	 * `state.messages`, so identity is exact and needs no content hashing or
	 * index arithmetic.
	 *
	 * A `WeakSet` so abandoned entries — a stalled turn's background `chatPi`
	 * call, or a {@link rebase} that replaces the transcript wholesale — can
	 * still be garbage collected.
	 */
	private durable = new WeakSet<object>();

	/**
	 * @param seeded length of the transcript the agent was spawned with
	 * (dilna's own persisted history). Everything at or before that point is
	 * already in the DB by construction.
	 */
	constructor(seeded: number) {
		this.examined = seeded;
		this.turnStart = seeded;
	}

	/**
	 * How far into the transcript this ledger has examined. Exposed for tests
	 * and logging only — production code must not slice on it (that is
	 * {@link settle}'s job, and it deliberately slices from a different mark).
	 */
	get position(): number {
		return this.examined;
	}

	/**
	 * Advance the position past `count` transcript entries without claiming
	 * any of them are durable — for entries that produce no row of their own
	 * (the turn's leading user-role entry, which dilna's placeholder already
	 * covers) and for entries whose write *failed*, which must still move the
	 * position or it desynchronizes from the transcript (issue #190, see the
	 * class doc).
	 */
	examine(count: number): void {
		this.examined += count;
	}

	/**
	 * This round's row is in the DB. Called only *after* the write succeeded,
	 * so a throw leaves the round for {@link settle} to pick up.
	 *
	 * An empty round (one that converts to no row at all) should be recorded
	 * too: it has nothing to write, and re-offering it would only make the
	 * safety net re-derive the same nothing.
	 */
	recordRound(entry: object): void {
		this.durable.add(entry);
	}

	/**
	 * The turn ended: return the entries still to be written — everything from
	 * the turn's start onward that no {@link recordRound} claimed.
	 *
	 * The slice deliberately spans rounds that *did* land, which is exactly why
	 * the identity filter is here and not left to `persistConverted`'s id-based
	 * dedup — both converters mint fresh ids, so an overlapping round would
	 * insert a second copy.
	 *
	 * Pure: returns the gap and moves nothing. The caller writes it and then
	 * calls {@link commit}, so a failed write leaves the ledger untouched and
	 * the same entries are retried as part of the next turn's wider,
	 * overlapping slice rather than being skipped forever.
	 */
	settle<T extends object>(messages: readonly T[]): T[] {
		return messages.slice(this.turnStart).filter((m) => !this.durable.has(m));
	}

	/**
	 * The gap {@link settle} returned is durable. Advances the position to the
	 * end of the transcript it was computed from, and starts the next turn
	 * there — nothing before this point can need re-offering again.
	 */
	commit(messages: readonly unknown[]): void {
		this.examined = messages.length;
		this.turnStart = this.examined;
	}

	/**
	 * Compaction replaced the transcript wholesale (ADR-0023). The new array
	 * is a reconstruction of already-persisted rows plus a synthetic summary —
	 * none of it is new data to persist, so the position tracks the
	 * replacement's own length rather than growing from its prior value, and
	 * the identity set is dropped along with the entries it referred to.
	 */
	rebase(messages: readonly unknown[]): void {
		this.examined = messages.length;
		this.turnStart = this.examined;
		this.durable = new WeakSet();
	}
}
