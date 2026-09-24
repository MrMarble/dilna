// Not type-only: the API error envelope's schema and `isApiErrorBody` guard
// are runtime values — the server shapes responses with them, the web client
// narrows with them.
export * from "./apiError";
// Type-only: response envelopes are plain types by design (ADR-0039's "type
// what goes out", extended to responses by ADR-0040) — the route annotates
// what it returns, the client types what it expects, and the compiler links
// the two.
export type * from "./apiResponses";
// Not type-only: these are Zod schemas, i.e. runtime values. The server
// validates with them; the web client derives its request types from them.
export * from "./apiSchemas";
// Not type-only: artefact.ts also exports the runtime
// `ARTEFACT_MAX_BYTES`/`formatArtefactSize` both sides share (issue #194).
export * from "./artefact";
export type * from "./diff";
export type * from "./events";
// Not type-only: the extension→language map and the name union, so the web's
// colour/icon map can be typed as a total `Record<DilnaLanguage, …>`.
export * from "./languages";
// Not type-only: the live-message fold is behaviour both server and web need
// to share (see the module's own doc comment), same as skill.ts below.
export * from "./liveMessage";
// Not type-only: messages.ts also exports the runtime
// `formatAttachmentSize`/`MAX_ATTACHMENTS_PER_MESSAGE` both sides share
// (issue #53), same as liveMessage.ts and skill.ts above/below.
export * from "./messages";
// Not type-only: notification.ts owns the turn-completion payload, its OS tag
// and the rule that decides when one fires — composed by the server's push
// sender, the web's in-page path, and the service worker that decodes the
// push, so all three agree by construction rather than by comment.
export * from "./notification";
// Not type-only: the path builders are runtime functions, the single source
// for every route address both sides must agree on.
export * from "./paths";
export type * from "./repo";
// Not type-only: the metric list and default threshold are runtime values
// the server validates against and the web offers as choices.
export * from "./scoring";
export type * from "./session";
// Not type-only like its neighbors: skill.ts also exports the
// encodeSkillId/decodeSkillId runtime functions both server and web need.
export * from "./skill";
// Not type-only: the reserved-slug set is a URL contract both sides need —
// the web refuses to navigate to such a slug, and the server must not mint
// one in the first place.
export * from "./slugs";
// Not type-only: the tool vocabulary is a runtime list plus the per-tool
// argument key, so the web can key a `Record<ToolName, …>` off the union and
// the server can validate against `TOOL_NAMES`.
export * from "./tools";
export type * from "./types";
export type * from "./usage";
