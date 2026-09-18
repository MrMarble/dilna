import { useCallback, useEffect, useState } from "react";
import {
	parseRoute,
	type Route,
	routePath,
	sessionIdFromSearch,
} from "@/lib/routes";

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
	/** A Session a push notification's tap target (`/?session=<id>`) asked for,
	 * captured once at load. Resolving it needs the repo/session lists, which
	 * only `App` has — so this reports the *request* and `App` turns it into a
	 * route once the data is there. Cleared by {@link clearRequestedSession}
	 * so it isn't re-applied on every render. */
	requestedSessionId: string | null;
	clearRequestedSession: () => void;
} {
	const [route, setRoute] = useState<Route>(() =>
		parseRoute(window.location.pathname),
	);
	// Read once, at mount: the tap target is always `/?session=<id>`, so there
	// is nothing to re-read on navigation, and the query string is dropped the
	// moment `App` resolves it.
	const [requestedSessionId, setRequestedSessionId] = useState<string | null>(
		() => sessionIdFromSearch(window.location.search),
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

	return {
		route,
		navigate,
		requestedSessionId,
		clearRequestedSession: () => setRequestedSessionId(null),
	};
}
