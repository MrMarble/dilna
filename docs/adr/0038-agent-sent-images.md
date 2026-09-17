# An Agent sends an image by minting an attachment, not a second media table

## Context

Issue #222: an Agent that produces an image — a Playwright screenshot, a
generated chart, a rendered diagram — has no way to put it in the chat. The
only Agent→user visual path is `dilna_publish_artefact`, which is HTML-only by
design (#194, ADR-0032), so the workaround is to base64-inline the PNG into a
throwaway HTML wrapper and publish that. The user gets an artefact-panel entry
to open rather than a picture in the conversation.

The user→Agent direction already works: the composer uploads a PNG, it lands in
`attachments`, and it renders inline in the transcript. This closes the loop.

The gap is smaller than it looks, because most of the pipeline never cared who
authored the row. With an `attachment` part on an assistant row, these work
unchanged: `messageStore.persistMessage` (`JSON.stringify(message.parts)`, no
role validation), `ChatMessageRow`'s `parts.filter((p) => p.type ===
"attachment")` (no role check — `role` only picks the avatar and
Markdown-vs-`<pre>`), `partsToMarkdown`, `sessions/transcript.ts`, and
`GET /api/sessions/:id/attachments/:attachmentId`. The user-only rule was
expressed purely as prose, in `db/schema.ts`, `packages/shared/src/messages.ts`
and `pi.ts`'s replay comment — never as a column or a check.

Four questions had real alternatives.

**Reuse `attachments` or mint an `images` table.** ADR-0032 faced the mirror of
this question and chose a *separate* `artefacts` table, so the symmetric answer
here would be a third table.

**How the part reaches the transcript.** pi-agent-core's assistant content
blocks are `text`/`toolCall`/thinking; `piRoundToDilnaMessage` drops everything
else. So a tool that wants to add an image to the *message* is writing a part no
round-to-row conversion will ever produce.

**What a cold start replays.** `dilnaMessagesToInitialState` explicitly ignored
`attachment` parts on assistant rows, with a comment asserting one "would be a
bug elsewhere" — the exact invariant this change breaks.

**How the bytes are served.** The attachment route sets `Content-Type` and
`Content-Disposition: inline` and nothing else. That was fine while every byte
came from the user's own upload.

## Decision

**Reuse the `attachments` surface, with a `source` column.** An Agent-sent image
is an `attachments` row with `source: "agent"`; a user upload is `source:
"user"` (backfilled for every existing row, which is what the column's `NOT NULL
DEFAULT 'user'` encodes). One storage directory, one serve route, one
`SentAttachment` renderer, one markdown branch, one transcript branch.

Chosen over a parallel `images` table because the two cases differ only in
authorship, not in shape or lifecycle: both are immutable bytes on disk outside
every Worktree, keyed by Session, rendered by the same component, served by the
same URL. ADR-0032 minted a separate table because an *artefact* genuinely
differs from an attachment — it has a `title`, a `sourcePath`, an iframe
renderer and a hostile CSP, and it appears in a panel rather than in the
transcript. An image has none of those differences. A third table would have
duplicated the renderer, the markdown branch, the transcript branch and the
serve route to distinguish two things that are the same thing.

`source` is carried even though nothing strictly *needs* it: without it the two
directions are indistinguishable for audit and debugging, the prose invariant
becomes silently false rather than explicitly widened, and the serve route has
no way to harden only model-chosen bytes. It is a column rather than a
re-derivation, for the same reason `kind` is: it records what actually happened,
so a later change to the rules cannot retroactively rewrite an already-sent
turn.

**Declaration:** an explicit `dilna_send_image(path, caption?)` tool
(`agents/imageTools.ts`), following `artefactTools.ts`'s shape — a `Type.Object`
schema, `ImageRejectedError` reflected as tool output rather than thrown (a
rejection is something the Agent can act on), and injected deps so the module
never reaches into `SessionManager`. `path` is resolved inside the Worktree and
checked with the symlink-resolving `isContained`, so the tool cannot copy an
arbitrary host file into a browser-fetchable URL.

**Bytes are copied**, not referenced, at send time — ADR-0032's reasoning
applies verbatim. A Worktree file is mutable and deletable by the next
`git checkout`, a branch switch, or a cleanup script, so a referenced image
would silently start 404ing after the user was handed it.

**The part is minted out-of-band, by the tool.** Since no pi content block can
carry it, `dilna_send_image` emits an `image_sent` `AgentStreamEvent` and the
live turn folds it into the in-flight assistant message's parts via
`applyEventToParts` — the same path `tool_call_start` takes. The image therefore
lands *positionally*, between the prose before it and the prose after it, rather
than being appended at the end of the turn.

**Replay sends the path, not the pixels.** A cold start reconstructs the whole
history, so an Agent-sent image replays as `[sent image: <filename> — <path>]`,
exactly mirroring ADR-0031's decision for user uploads and for the same reason:
re-encoding every image a Session ever sent would grow the seeded context
without bound and re-charge the user for pictures the turn already acted on. The
Agent keeps the path, which is what it needs to look again.

**Serving is hardened for both directions.** The attachment route now sets
`X-Content-Type-Options: nosniff`, a `default-src 'none'; sandbox` CSP, and
`Referrer-Policy: no-referrer`, and it serves the stored MIME only if it is
still in `IMAGE_MIME_TYPES` (or the generic binary type for documents), rather
than trusting whatever the row records. Applied to user uploads too, not just
Agent-sent ones: the hardening costs an image nothing, and a route whose safety
depends on which column a row carries is one refactor away from not having it.

**Scope:** still images only, Agent→user, `IMAGE_MIME_TYPES` and
`ATTACHMENT_MAX_BYTES` (4MB) unchanged. The MIME is sniffed from the file's
magic bytes rather than its extension — the extension is the Agent's claim about
a file it chose, and `Content-Type` is the one header the browser acts on.

## Consequences

- The `attachments` table's meaning widens from "a file the user uploaded" to "a
  file in this Session's chat, in either direction". That is a real cost: three
  prose comments asserting user-only had to be rewritten rather than deleted,
  and `source` is now the thing that answers the question they used to answer by
  construction.
- `applyEventToParts` gains its first non-text, non-tool case, and
  `isMessageContentEvent` has to gain `image_sent` with it — `liveMessage.test.ts`
  asserts the two agree exactly, which is what makes that pairing hard to get
  wrong.
- An Agent can now put bytes on a URL the browser fetches from dilna's own
  origin. That is precisely why the route hardening is in this ADR rather than
  deferred: the capability and its mitigation land together.
- Read-only subagents (ADR-0034) do **not** get this tool, for the same reason
  they don't get `dilna_publish_artefact`: a subagent reports to its parent, not
  to the user's transcript.
- `ChatMessageRow` no longer hoists attachments above the message text. User
  messages are unaffected in practice (the server already orders their
  attachment parts first), but an Agent interleaving an image into prose needs
  the image to stay where it was sent.
- Nothing prunes Agent-sent images any more than it prunes uploads; both die
  with the Session. Same tolerance, and the same eventual revisit, as ADR-0031.
