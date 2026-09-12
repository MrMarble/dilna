# Attachments are stored outside the Worktree, and reach the Agent by two channels

## Context

Issue #53 asked for image and document attachments in the chat composer.
`MessagePart` was text-only, so this needed a shared-contract change, storage,
and a way for the Agent to actually use an uploaded file.

Two questions had real alternatives.

**Where the bytes live.** The obvious cheap option is to drop uploads into the
Session's Worktree — the Agent already has full read/write access there, so
nothing else would need to change. But a Worktree is a git checkout: an upload
landing in it shows up in `git status`, in the Session's diff panel, and
eventually in a commit the user never asked for. A screenshot pasted to ask
"why does this look wrong?" is a chat artifact, not a source change, and the
two must not be conflated.

The other alternative was inlining base64 in the `messages` row. That row is
read wholesale on every render, every transcript export and every cold-start
re-seed, so a single 3MB screenshot would be re-parsed and re-serialized on all
three paths for the life of the Session.

**How the Agent sees a file.** `pi-agent-core`'s `prompt(text, images)` sends
images inline as base64, which is the only way a Provider sees pixels. But that
channel is useless for a PDF, and even for an image it doesn't let the Agent
*act* on the file — a model cannot write back the pixels it was shown, so
"crop this and save it to `assets/`" needs a path.

## Decision

**Storage:** bytes on disk at `<DILNA_DATA_DIR>/attachments/<sessionId>/`,
metadata in an `attachments` table, and a snapshot of that metadata embedded in
the `MessagePart` that references it. Deliberately outside every Worktree.
Messages therefore render, export and re-seed from the row alone, with no join
that could come back empty, while the bytes are fetched separately (and only by
the renderer that needs them) from `GET /api/sessions/:id/attachments/:id`.

**Access:** the Session's attachment directory is granted to the Agent
**read-only** — both in `confinement.ts` (for the path-taking tools) and in the
sandbox grant's new `readOnlyPaths` (for bash). Copying a file *into* the
Worktree is the supported way to act on one; editing the user's original in
place is not.

**Prompt:** every attachment's absolute path is named in a preamble ahead of
the user's text, images included, and images *additionally* travel inline as
base64. The preamble also tells the Agent the paths sit outside the worktree
and that copying one in is the user's call — which is what makes the storage
choice usable rather than merely safe.

**Replay:** a cold start reconstructs the whole history, so attachments replay
as their paths only, never re-inlined. Re-encoding every image a Session ever
received would grow the seeded context without bound and re-charge the user for
pictures the turn already acted on.

## Consequences

- An upload is reachable but never committed by accident. "Put this image in
  `public/`" becomes an explicit instruction the user gives, which is the
  intended affordance, not a workaround.
- Nothing prunes orphaned uploads: a file the user attached and never sent
  keeps its row and bytes until the Session is deleted, which removes both.
  Acceptable for a single-tenant self-hosted app; revisit if it ever isn't.
- `ATTACHMENT_MAX_BYTES` sits under the global `bodyLimit` in `index.ts`, so an
  oversized file gets a 413 naming the limit instead of being truncated by
  middleware. The two have to move in that order.
- Only the four image MIME types every Provider in dilna's catalog accepts take
  the inline channel. An `image/tiff` is classified as a document, which
  degrades to "the Agent reads it off disk" rather than a turn-level API error.
- Files reach the tray three ways — the Plus button's picker, paste, and drag
  and drop — but all three funnel into one `addFiles`, so the upload, cap and
  error handling have a single implementation.
- `MAX_ATTACHMENTS_PER_MESSAGE` and `formatAttachmentSize` live in
  `packages/shared` because both sides enforce/render them and must agree; two
  independent copies of the cap had already drifted (20 in the route schema vs
  10 in the resolver) before they were unified.
