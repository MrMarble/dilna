# The chat stream folds into a pure reducer, and the fetch it triggers is an effect

## Context

`ChatShell.tsx` handled the `AgentStreamEvent` stream in a ~140-line
`switch (ev.type)` inside its subscription `useEffect`. Each case called
between one and four of a dozen `useState` setters from the enclosing
component — `setMessages`, `setLive`, `setStatus`, `setQueued`, `setThinking`,
`setTurnActivity`, `setThinkingBuffers`, `setError`, `setNotice`,
`setDegraded` — plus `sawTurnRef`, a mutable ref encoding "a turn is in
flight" because a `setState` updater has no way to *read* a sibling's value.

The case bodies already read as transitions of one state value: they take
prior state, an event, and produce next state. That is a reducer spread across
independent setters, which is why it could only be observed through rendering
— a test had to mount the whole component, stub the API, and assert on the
DOM to reach even the simplest transition. The residue of #203 (closed without
producing a reducer) and re-measured in #205, this is issue #237.

The dependency that had to move with it is the stream itself. #202's
`SessionStreamHub` took the *transport* concern, but the reducer's input
still arrived through a callback registered inside a `useEffect` whose body
also owned the backoff/degrade timer and the reconcile's fetch. Splitting the
fold from that timer is what makes both testable: the fold needs no timers,
and the timer needs no rendering.

## Decision

**One pure module, `apps/web/src/lib/chat-reducer.ts`, owns the whole fold.**
`ChatState` collects the ten values the stream reads and writes; `chatReducer`
folds one `ChatAction` into it. The module sits in `lib/`, beside
`live-messages.ts` — the precedent for pulling a piece of this component's
logic out of the render path and testing it directly.

**`ChatAction` is `AgentStreamEvent | <non-stream transitions>`.** The
majority of actions are literally the events on the wire, so the exhaustive
`switch` that used to fail the build on a new variant (and is what caught
`image_sent` being silently dropped, #222) keeps doing so — now in the
reducer instead of the component. The rest are the transitions a setter used
to perform that are not wire events: the resync directive's `reset`, the two
REST snapshots the on-open routine fetches (`history_loaded`,
`queue_loaded`), the send flow's optimistic start/accept/withdraw, and the
local edits the component makes around its own async calls (queue tray, error
clearing).

**The imperative remainder stays in the component and dispatches.** The
transport subscription, the 3s degrade timer, and `loadHistory`/`loadQueue`
cannot be pure, so they remain effects — but they now *dispatch* their
outcomes rather than setting state. `resync` is `dispatch({type: "reset"})`
plus the two fetches; the connection callback dispatches `degraded`; the
stream callback is `(ev) => dispatch(ev)`.

**The reconcile fetch is signalled, not performed, by the reducer.** At a
terminal status the fold already has to flush `live` into `messages` (pure),
but it also has to refetch history because the DB is the source of truth
(ADR-0004) and the flushed rows carry provisional ids. The fold therefore
increments `state.reconcile` when — and only when — it just ended a turn this
tab actually saw, and an effect keyed on that counter performs the fetch.
`sawTurn` moves from a ref into state, which is what makes the "subscribe-time
idle snapshot must not refetch" rule expressible as a pure transition and
testable without a subscription.

**`sessionId` is part of the state.** The terminal flush mints `Message` rows,
and a `Message` needs its `sessionId`; carrying it in state is also what
`session_changed` compares against to distinguish a resync from an actual
conversation switch.

### Alternatives rejected

**Keeping the setters and extracting only a helper per case.** Each helper
would still take and return a dozen loose values, or a bag of them — a
reducer with extra steps and a weaker type. The point of the fold is that
these values transition together (a terminal status touches seven of them),
so splitting them is what created the bug class in the first place.

**A `useReducer` with the clock passed as a third argument.** `message_start`
and a `token` for a message the tab never saw start must stamp a `startedAt`,
which is the only impurity in the fold. Threading `now` as a third parameter
is the honest signature and mirrors `applyEventToLive`'s existing injectable
clock — but React 19's `useReducer` types infer the dispatch argument tuple
from the reducer's signature, so a three-argument reducer makes `dispatch`
demand two arguments. The component therefore wraps it: `useReducer((s, a) =>
chatReducer(s, a), …)`. The wrapper is one line and invisible to tests, which
call `chatReducer(state, action, fixedClock)` directly.

**Stamping the timestamp onto the action at dispatch time.** This would keep
the reducer a strict two-argument function, at the cost of every
`message_start` action no longer being the shared event type — reintroducing
a parallel action shape for one field. Rejected: the wrapper above costs
less and keeps `ChatAction`'s event arm exactly `AgentStreamEvent`.

**Putting the degrade timer's `degraded` flag in the component instead.**
This was the initial instinct — it is connection UI, not chat *content* —
but it is written by the same subscription's callbacks, so leaving it as a
setter would have kept the component mixed-mode (some stream outcomes
dispatched, one set) for no benefit. It is one field and one action.

**Making `sending` reducer state too.** `sending` is the composer's own
in-flight flag for its POST, read by two buttons and nothing else; the stream
never touches it. It is the one piece of the send flow left as `useState`, on
the same boundary that keeps the draft, the slash menu and the drag counter
out.

## Consequences

- `ChatShell.tsx` loses its entire event vocabulary: it no longer imports
  `AgentStreamEvent` or `applyEventToLive`, and drops from 1577 to ~1388 LOC
  while gaining no behaviour. The conversation between a test and the stream
  no longer has to pass through the DOM.
- The hardest cases become table-driven assertions on transitions instead of
  mounted renders: the terminal flush-then-reconcile, `message_start`
  idempotence, the `user_message` sender/non-sender race, the `tool_call_end`
  exception to "content stops thinking", and the `image_sent` regression that
  motivated the exhaustive switch. `chat-reducer.test.ts` runs with no jsdom,
  no React and no mocked API — 37 tests in tens of milliseconds.
- The 42 existing `ChatShell.*.test.tsx` tests pass unchanged. They still earn
  their place: they cover the rendering, the composer and the API wiring that
  the reducer deliberately does not. But they are no longer the *only* way to
  reach a stream transition.
- Referential identity is preserved deliberately (`chatReducer` returns the
  same state for a no-op), matching the setters' bail-out — the transcript is
  the largest subtree in the app and must not re-render for a `notice` the
  user has already seen.
- The reducer still receives live `AgentStreamEvent`s unchanged and the
  reducer consumes them in the same order, so this is not a change to the
  event contract, the transport (#202), or the resync routine of ADR-0016 §4.
- Out of scope, and unchanged: `AgentStreamEvent`'s shape, `SessionStreamHub`,
  and `live-messages.ts`. The reducer *composes* `applyEventToLive` for the
  content cases rather than reimplementing the parts fold.
