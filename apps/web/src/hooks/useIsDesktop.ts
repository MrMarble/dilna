import { useMediaQuery } from "@base-ui/react/unstable-use-media-query";

// Tailwind's default `md` breakpoint (no `--breakpoint-md` override in
// index.css), matching the `md:hidden`/`md:flex` classes used throughout —
// see issue #12.
const DESKTOP_QUERY = "(min-width: 768px)";

/** True on viewports at/above the `md` breakpoint. Used to gate
 * desktop-only affordances (e.g. Enter-to-send, which relies on a Shift
 * key that mobile keyboards don't reliably expose). */
export function useIsDesktop() {
	return useMediaQuery(DESKTOP_QUERY, { noSsr: true });
}
