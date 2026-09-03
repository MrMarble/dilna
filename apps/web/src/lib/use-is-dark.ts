import { useEffect, useState } from "react";

const DARK_CLASS = "dark";

function readDark(): boolean {
	return document.documentElement.classList.contains(DARK_CLASS);
}

/**
 * Subscribes to the `.dark` class on <html> (the single source of truth the
 * theme layer toggles) so color choice made from a deep component — like the
 * Prism theme picked per code block — tracks both manual toggles and OS
 * preference changes without threading the useTheme context down.
 */
export function useIsDark(): boolean {
	const [dark, setDark] = useState<boolean>(() => readDark());

	useEffect(() => {
		const observer = new MutationObserver(() => setDark(readDark()));
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class"],
		});
		// Class may have changed before we mounted.
		setDark(readDark());
		return () => observer.disconnect();
	}, []);

	return dark;
}
