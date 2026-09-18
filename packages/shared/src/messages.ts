import type { WireToolName } from "./tools";

/** How an {@link Attachment} is presented to the user and handed to the
 * Agent. `"image"` is the only kind a Provider can see *as pixels* — it
 * travels inline in the prompt as base64 (`pi-agent-core`'s
 * `prompt(text, images)`), and renders in chat as the picture itself. Every
 * other upload is a `"document"`: the Agent is told where it is on disk and
 * reads it with its own tools, and chat renders a name-and-icon card.
 *
 * Derived from the MIME type at upload time and stored, rather than
 * re-derived per render: the kind decides which prompt channel the file
 * took, so a later change to the derivation rule must not retroactively
 * rewrite what an already-sent turn claims to have sent. */
export type AttachmentKind = "image" | "document";

/**
 * MIME types dilna sends to a Provider as actual image content. Restricted
 * to the four every vision-capable Provider in dilna's catalog accepts —
 * deliberately *not* "anything `image/*`", because an unsupported image type
 * (`image/tiff`, `image/heic`) reaching the Provider is a turn-level API
 * error, whereas classifying it as a document degrades to "the Agent can
 * read the file off disk", which still works.
 *
 * Lives here rather than on the server because the web has to classify the
 * same file: it decides whether the composer shows a thumbnail. The web used
 * a looser `startsWith("image/")` test, so a `.heic` previewed in the tray
 * and then rendered as a file card once sent. */
export const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
]);

/** Normalize a stored MIME for comparison against {@link IMAGE_MIME_TYPES} —
 * lowercased and stripped of any `; charset=…` parameter. */
export function bareMimeType(mimeType: string): string {
	return mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
}

/**
 * Which channel a file takes to the Agent, decided once at upload time from
 * the MIME type the browser reported.
 *
 * `"image"` means the bytes travel inline in the prompt as base64 and the
 * Provider sees the picture. `"document"` means the Agent is told the path
 * and reads it with its own tools. The fallback is `"document"` precisely
 * because it's the one that can't fail at the Provider: every file is
 * readable off disk, only some are viewable.
 *
 * Shared so the server (which stores the kind) and the web (which previews
 * from the same MIME type) can't disagree about one file. */
export function attachmentKindFor(mimeType: string): AttachmentKind {
	return IMAGE_MIME_TYPES.has(bareMimeType(mimeType)) ? "image" : "document";
}

/** Who put an {@link Attachment} into the chat (issue #222, ADR-0038).
 *
 * `"user"` is an upload from the composer; `"agent"` is an image the Agent
 * sent with `dilna_send_image`. The two are otherwise identical — same
 * storage, same serve route, same renderer — so this exists to keep them
 * *distinguishable* for audit and debugging, and to let the serve route reason
 * about which bytes were chosen by a model.
 *
 * Stored rather than inferred from the owning row's role, for the same reason
 * {@link AttachmentKind} is: it records what actually happened, so a later
 * change to the rules can't retroactively rewrite an already-sent turn. */
export type AttachmentSource = "user" | "agent";

/** A file in a Session's chat, stored outside every Worktree (see ADR-0031)
 * and referenced from the message that sent it.
 *
 * Travels in both directions (ADR-0038): the user uploads one from the
 * composer, and the Agent sends one with `dilna_send_image`. {@link source}
 * says which.
 *
 * Deliberately carries no bytes: this shape travels in every `Message` the
 * chat renders, the transcript export serializes, and the Agent re-seeds
 * from, so inlining even a small image would multiply through all three.
 * The web fetches the bytes separately from
 * `GET /api/sessions/:sessionId/attachments/:id` only for the kinds that
 * actually render them. */
export type Attachment = {
	id: string;
	sessionId: string;
	/** The name as the user's filesystem had it, kept for display and for
	 * naming the file the Agent is pointed at. Sanitized at upload (see the
	 * server's `attachments.ts`) — never used to build a path unvalidated. */
	filename: string;
	mimeType: string;
	/** Bytes on disk. Shown on the document card, and what the upload limit
	 * is enforced against. */
	size: number;
	kind: AttachmentKind;
	/** Which direction this file travelled (issue #222, ADR-0038). Optional in
	 * the type because rows predating the column replay without it; the server
	 * backfills `"user"` on read, so treat an absent value as `"user"`. */
	source?: AttachmentSource;
	/** Absolute path on the server, inside the Session's attachment
	 * directory. Present so the *Agent* can be told where to find the file —
	 * it is the whole point of storing outside the Worktree (the user asks
	 * the agent to copy it in if they want it committed). Sent to the web
	 * too, which only ever displays it as a hint; the browser can't read it. */
	path: string;
	createdAt: number;
};

export type MessagePart =
	| { type: "text"; text: string }
	| {
			type: "tool_call";
			callId: string;
			/** dilna's tool vocabulary ({@link WireToolName}), not the provider's — the
			 * web picks its icon and detail off this, so it is a narrowed union
			 * rather than an open string. */
			tool: WireToolName;
			input: unknown;
			output: unknown;
			error?: string;
	  }
	/** A file sent with this message, in either direction (issue #222,
	 * ADR-0038). On a `"user"` row it's an upload from the composer; on an
	 * `"assistant"` row it's an image the Agent sent with `dilna_send_image`,
	 * and `attachment.source` distinguishes them.
	 *
	 * An assistant row's part is minted by the tool, not by
	 * `piRoundToDilnaMessage` — pi-agent-core's assistant content blocks are
	 * text/toolCall/thinking, so no round-to-row conversion can produce one.
	 * It reaches the live message through the `image_sent` event and
	 * {@link applyEventToParts}, which is what keeps it positioned between the
	 * prose before and after it rather than appended at the end of the turn.
	 *
	 * The part embeds the full {@link Attachment} record rather than just an
	 * id so a message renders, exports and re-seeds from the row alone, with
	 * no second lookup and no join that could come back empty. The
	 * `attachments` table stays the source of truth for the file itself (it's
	 * what `GET /api/sessions/:sessionId/attachments/:id` serves and what
	 * deletion walks); this is a snapshot of its metadata at send time, which
	 * is the correct thing for a transcript to preserve even if the row is
	 * later gone. */
	| { type: "attachment"; attachment: Attachment };

export type Message = {
	id: string;
	sessionId: string;
	/** `"system"` (ADR-0026) is dilna's own synthetic role, never something an
	 * agent backend produces — used exclusively for a durable, boot-time
	 * interruption notice (`SessionManager.resetAllToIdle`). Render distinctly
	 * from `"user"`/`"assistant"` (an inline notice, not a chat bubble). */
	role: "user" | "assistant" | "system";
	parts: MessagePart[];
	createdAt: number;
	/** Groups the rows one user turn produced. ADR-0026 §3 persists an
	 * assistant response as one row per pi-agent-core *round*, so a turn that
	 * calls tools across several rounds lands as several consecutive rows —
	 * this is the id that says they're one turn, so the chat renders them as
	 * one message with one grouped tool-call section (the shape the live view
	 * already has, via `NormalizeState.currentMessageId`) instead of N
	 * separate messages after a reload.
	 *
	 * Minted once per turn by `SessionManager.runTurn` and stamped on every
	 * row that turn writes, whichever path wrote it (incremental
	 * `persistRoundEvent` or the turn-end safety net), so grouping survives a
	 * reload regardless of which path won the race.
	 *
	 * Null for every row that isn't part of an agent turn: user rows (a turn
	 * has exactly one, and the user is never grouped with the reply),
	 * `"system"` boot-time notices (ADR-0026 §2), and rows persisted before
	 * this field existed. Consumers must treat null as "own message, never
	 * grouped" — never as a value to coalesce.
	 *
	 * Required (not optional) despite being nullable: "no turn" is a real,
	 * meaningful state that every producer must state, and making it optional
	 * would give `undefined` a second, silently-equivalent encoding for the
	 * same thing. One representation, so a consumer never has to normalize
	 * both. */
	turnId: string | null;
};

/**
 * Hard cap on how many files one message may carry. Lives here because both
 * sides enforce it and they must agree: the composer stops the user at the
 * picker, the server rejects a send that exceeds it. Two independent
 * constants drifted apart once already (the route's zod schema said 20 while
 * the server's own resolver said 10, so a 15-id send passed validation and
 * then failed downstream).
 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/**
 * A message the user submitted while the Session's Agent was busy with a
 * turn (ADR-0033) — held server-side in the `queued_messages` table, not a
 * `messages` row: nothing has been sent to the Agent yet, and the entry is
 * removable until it dispatches. When the in-flight turn ends, the whole
 * queue is drained into the *next* turn (all entries combined into one
 * message) and cleared.
 *
 * `attachments` is a snapshot of the already-uploaded records (the tray
 * uploads eagerly, so ids exist by enqueue time) — same reasoning as
 * `MessagePart`'s attachment variant: the queue renders filenames without a
 * per-entry fetch, and the records are stable until the Session is deleted,
 * which drops its queue too.
 */
export type QueuedMessage = {
	id: string;
	sessionId: string;
	text: string;
	attachments: Attachment[];
	/** Epoch seconds. */
	createdAt: number;
};

/**
 * Render a byte count the way dilna shows file sizes — on the composer's
 * pending tray, on a sent message's document card, and in the prompt
 * preamble the Agent reads.
 *
 * Shared rather than duplicated per side: all three render the *same*
 * attachment's size, so a divergence would have the user and the Agent
 * quoting different numbers for one file.
 */
export function formatAttachmentSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type SendMessageInput = {
	text: string;
	/** Attachments to send with this message, already uploaded via
	 * `POST /api/sessions/:id/attachments` — the send references them by id
	 * rather than carrying bytes, so the turn-claiming POST stays a small
	 * JSON body and an upload that fails never costs the user their draft.
	 * Ids that don't belong to this Session are rejected, not ignored. */
	attachmentIds?: string[];
};
