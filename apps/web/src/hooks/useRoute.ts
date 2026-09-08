import { useCallback, useEffect, useState } from "react";
import { parseRoute, type Route, routePath } from "@/lib/routes";

/**
 * The current {@link Route}, as React state, kept in sync with the address bar
 * in both directions: `navigate` pushes (or replaces) and re-renders, and the
 * browser's own back/forward re-derives the route from `window.location`.
 *
 * Holding the location in state — rather than reading `window.location`
 * ad-hoc at each render/handler, as `App` used to — is what makes the URL the
 * single source of truth for which view is showing. A component can't end up
 * rendering one view while the path says another, because there's only one
 * value driving both.
 *
 * `useSyncExternalStore` would be the textbook fit for subscribing to
 * `popstate`, but it has no way to *write* to the store, so pushes would still
 * need a separate path and the two could tear. Plain state plus an explicit
 * `navigate` keeps writes and reads going through the same setter.
 */
export function useRoute(): {
	route: Route;
	navigate: (route: Route, options?: { replace?: boolean }) => void;
} {
	const [route, setRoute] = useState<Route>(() =>
		parseRoute(window.location.pathname),
	);

	useEffect(() => {
		function onPopState() {
			setRoute(parseRoute(window.location.pathname));
		}
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, []);

	const navigate = useCallback(
		(next: Route, options?: { replace?: boolean }) => {
			const path = routePath(next);
			// Re-navigating to the path we're already on shouldn't stack a
			// duplicate history entry that "back" then has to chew through — but
			// the state still updates, since the same path can be reached from a
			// route object carrying fresher data.
			if (path !== window.location.pathname) {
				if (options?.replace) window.history.replaceState(null, "", path);
				else window.history.pushState(null, "", path);
			}
			setRoute(next);
		},
		[],
	);

	return { route, navigate };
}
