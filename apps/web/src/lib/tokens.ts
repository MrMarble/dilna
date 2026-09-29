// Re-export: the implementation moved to `packages/shared` (issue #291) so
// the server's burn-finding evidence text and this dashboard agree on token
// formatting by construction. Existing `@/lib/tokens` imports keep working.
export { formatTokenCount } from "@dilna/shared";
