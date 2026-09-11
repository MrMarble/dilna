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

/** A file the user uploaded to a Session, stored outside every Worktree (see
 * ADR-0031) and referenced from the message that sent it.
 *
 * Deliberately carries no bytes: this shape travels in every `Message` the
 * chat renders, the transcript export serializes, and the Agent re-seeds
 * from, so inlining even a small image would multiply through all three.
 * The web fetches the bytes separately from `GET /api/attachments/:id` only
 * for the kinds that actually render them. */
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
			tool: string;
			input: unknown;
			output: unknown;
			error?: string;
	  }
	/** A file the user sent with this message. Only ever appears on a
	 * `"user"` row — an Agent has no way to produce one (it writes files into
	 * the Worktree instead), so nothing in the normalization path mints these.
	 *
	 * The part embeds the full {@link Attachment} record rather than just an
	 * id so a message renders, exports and re-seeds from the row alone, with
	 * no second lookup and no join that could come back empty. The
	 * `attachments` table stays the source of truth for the file itself (it's
	 * what `GET /api/attachments/:id` serves and what deletion walks); this is
	 * a snapshot of its metadata at send time, which is the correct thing for
	 * a transcript to preserve even if the row is later gone. */
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

export type SendMessageInput = {
	text: string;
	/** Attachments to send with this message, already uploaded via
	 * `POST /api/sessions/:id/attachments` — the send references them by id
	 * rather than carrying bytes, so the turn-claiming POST stays a small
	 * JSON body and an upload that fails never costs the user their draft.
	 * Ids that don't belong to this Session are rejected, not ignored. */
	attachmentIds?: string[];
};
