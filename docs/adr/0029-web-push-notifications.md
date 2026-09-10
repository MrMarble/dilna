# Web Push notifications for turn completion

## Context

Turn-completion notifications (issue #52, `useSessionNotifications.ts`) were
built for a desktop browser and do not work on a phone — which is where the
operator actually uses dilna. The existing hook has exactly one delivery
mechanism: the page-scoped `new Notification()` constructor, called from the
SSE `session_status` handler when a session's turn completes while unfocused.

Three properties of that design fail on mobile:

1. **`new Notification()` is not supported on Chrome for Android.** It throws
   `TypeError: Illegal constructor`; Chrome requires
   `ServiceWorkerRegistration.showNotification()` on mobile. The hook wraps
   the call in `try { … } catch {}` (added for older Safari), so the failure
   is swallowed and invisible — no console error, no UI signal. The unread
   badge, which is computed on the same code path *before* the notification
   attempt, keeps working. The observable result is "badges work, the phone
   never buzzes."

2. **Delivery requires a live JS context.** Even where the constructor works,
   it only fires while the page is running. Android routinely evicts
   backgrounded tabs under memory pressure, which also drops the
   `api.sessionList.stream` SSE connection the whole mechanism hangs off. A
   turn completing while the phone is locked cannot notify, because the event
   is never received.

3. **Recovery after eviction is suppressed by design.** `previousStatusRef`
   is in-memory. After a reload or eviction, the first `session_status` event
   per session has `prev === undefined`, and the guard
   `if (!prev || !ACTIVE.includes(prev) …) return` skips it. This is correct
   for avoiding a burst of false notifications on every reload, but it means
   the completion that happened *while the tab was dead* is structurally
   incapable of notifying once the tab comes back.

dilna ships a PWA shell already (`manifest.webmanifest`, `display:
standalone`, apple-mobile meta tags) but has no service worker at all — a
repo-wide grep for `serviceWorker|showNotification|pushManager|web-push|vapid`
returns nothing. So the app is installable but has no background delivery
path.

## Decision

Add Web Push, scoped to Android/Chrome as the target platform.

### 1. Service worker + `showNotification()`

Add a service worker with a `push` handler that calls
`registration.showNotification()`. This is both the fix for mobile Chrome's
missing `Notification` constructor and the prerequisite for push.

### 2. Web Push with a DB-persisted VAPID keypair

The server sends a push message on turn completion, so delivery no longer
depends on a live page.

**Keys live in SQLite, generated on first boot when absent.** VAPID keys must
be stable — regenerating them invalidates every existing subscription. A
single-row table (following the `llm_config` congruence-key pattern) is
generated once and reused. This is consistent with `provider_credentials`,
which already establishes plaintext secrets in SQLite as acceptable for a
self-hosted single-user app with no auth layer. No env var is required; the
operator never has to manage key material.

**Subscriptions are instance-global.** dilna has no `userId` anywhere in the
schema and authenticates with one shared bearer token, so a
`push_subscriptions` table keyed by endpoint needs no ownership model. Every
registered browser gets every notification.

**No `web-push` dependency.** The canonical library was last published in
January 2024 and pulls five transitive dependencies. Everything required —
P-256 keygen, ES256 JWT signing (`dsaEncoding: "ieee-p1363"`), ECDH, HKDF,
and AES-128-GCM for RFC 8291 payload encryption — is available in Node's
built-in `node:crypto`. Implemented directly, this is a contained amount of
code against two stable RFCs, and avoids taking on an unmaintained dependency
for a security-sensitive path.

### 2b. Delivery accepts its transport

`notifyTurnComplete` takes an optional `PushTransport` rather than reaching
for the global `fetch`. Delivery *policy* — 404/410 prunes the subscription,
anything else retains it — is the most consequential logic in the module:
pruning a live endpoint silently unsubscribes a working phone, and retaining
a dead one leaks rows forever. With `fetch` baked in, that policy sits past
the interface where no test can reach it.

### 3. Send from `transitionStatus()`

ADR-0016 §1 established `transitionStatus()` as the single funnel every
status change runs through, firing exactly once per turn and only after the
turn's durable content is persisted. The push send goes there, alongside the
existing `broadcastGlobal` call, and inherits those guarantees for free.

Server-side sends have no notion of which session the user is looking at, so
the client-side focus suppression (`if (focused) return`) does not apply to
push. Push fires for any `working → idle` completion.

### 4. The in-page `Notification` path is retained as-is

Per the operator's decision, the existing `new Notification()` call stays.
On desktop it continues to work as before; on Android Chrome it throws and is
swallowed, exactly as it does today. See the deduplication note below.

## Deduplication: a known, accepted risk

**Push and the in-page path are independent and will double-notify on any
platform where both work.** They are driven by the same `working → idle`
transition with no shared state: the server sends a push regardless of
whether a tab is open, while an open tab independently fires
`new Notification()` off the SSE event.

This is **not** currently observable on the target platform, which is why it
is accepted rather than fixed:

- On Chrome for Android, `new Notification()` throws (see Context #1), so the
  in-page path cannot fire and cannot duplicate.
- On desktop, both paths work and duplicates *are* possible — mitigated only
  partially by both sides using the same notification `tag`
  (`dilna:<sessionId>`), which makes the OS replace rather than stack the
  notification. Tag collision suppresses the second *visible* entry but may
  still produce a second alert/buzz depending on platform and `renotify`.

**If duplicates start appearing — in particular if a future Chrome for
Android gains `Notification` constructor support, or if the in-page path is
ever changed to use `showNotification()` — the fix is:** in the service
worker's `push` handler, call `clients.matchAll({ type: "window" })` and skip
`showNotification()` when a visible dilna client already exists, letting the
in-page path own that case. That is the only place with visibility into both
worlds. It was deliberately not implemented now, to avoid adding machinery
for a problem that does not currently manifest.

## Consequences

- Turn completions reach an Android phone with the browser closed, which is
  the primary way the operator uses dilna.
- dilna gains a service worker. It is scoped to push only — no offline
  caching, no asset precaching — to avoid the stale-asset class of PWA bugs.
- Notifications require the site to be installed or at least permission-
  granted; on iOS (out of scope here) push additionally requires a
  home-screen install, and the in-page path never worked there either.
- A new secret lives in the DB. It is a VAPID *server* key, useful only for
  signing pushes to this instance's subscribers — not a credential for any
  third-party service.
- Subscriptions expire or are revoked by the browser. The sender must prune
  on `404`/`410` responses, or the table accumulates dead endpoints.
- `/api/push/subscribe` persists a URL the server later POSTs to, and dilna's
  bearer auth is opt-in (`DILNA_AUTH_TOKEN`), so on a default deployment the
  route is unauthenticated. Endpoints are required to be HTTPS, which rejects
  `file://` and plaintext probes at internal services, but an `https://` URL
  pointing at a private address is still accepted. A tighter fix would be an
  allowlist of known push origins, at the cost of breaking self-hosted push
  services.
- `transitionStatus` pays one extra `SELECT` per status change to read the
  pre-write status. The in-memory `active` registry can't substitute for it:
  `stopSession`/`markCrashed` delete their entry *before* transitioning, so
  reading it would report "no turn was running" exactly when one just did.
- The unread-badge path is unchanged and remains the always-on fallback for
  browsers where push is unavailable or permission is denied.
