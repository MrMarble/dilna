/**
 * Presentation formatters both sides share — the server stamps them into
 * human-readable evidence text (`sessions/burnFindings.ts`) and the web
 * renders them in dashboards, so the two must agree by construction rather
 * than by comment. Rules mirror the existing shared runtime modules
 * (`formatArtefactSize`, `formatAttachmentSize`): pure, synchronous, no
 * DOM, no locale-dependent APIs.
 */

/**
 * Format a token count compactly for dashboards and evidence text —
 * "950", "1.5k", "200k", "1.0m". Sub-10k counts keep one decimal so a
 * 1,200-token turn doesn't collapse into an unreadable "1k".
 */
export function formatTokenCount(n: number): string {
	if (n < 1_000) return String(n);
	if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}m`;
}

/**
 * Format a USD amount the way the Metrics dashboard reads best: "$1.23"
 * at ordinary sizes, widening precision as the value shrinks. Cheap/
 * cached-heavy turns routinely cost a fraction of a cent — 4 decimals
 * alone rounds anything under $0.0001 down to a misleading "$0.0000",
 * hiding real spend.
 */
export function formatUsd(n: number): string {
	if (n === 0) return "$0.00";
	if (n < 0.000001) return "<$0.000001";
	if (n < 0.0001) return `$${n.toFixed(6)}`;
	if (n < 0.01) return `$${n.toFixed(4)}`;
	return `$${n.toFixed(2)}`;
}
