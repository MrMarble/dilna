import { useRef, useState } from "react";

export type MobileSheetKey = "menu" | "files";

/**
 * Shared open/active-content state for the mobile header's menu/files icons
 * and the single bottom sheet they both drive (issue #12): tapping an icon
 * opens the sheet showing that icon's content; tapping the same icon again
 * closes it; tapping the other icon swaps content in place without closing
 * first, so the sheet never stacks or re-plays its open animation.
 */
export function useMobileSheet() {
	const [active, setActive] = useState<MobileSheetKey | null>(null);
	const menuTriggerRef = useRef<HTMLButtonElement>(null);
	const filesTriggerRef = useRef<HTMLButtonElement>(null);
	// Stays pointed at the last active key through the close transition (once
	// `active` has already gone back to null), so the drawer's `finalFocus`
	// still targets the triggering icon instead of losing it mid-close.
	const lastActiveRef = useRef<MobileSheetKey>("menu");
	if (active !== null) lastActiveRef.current = active;

	function toggle(key: MobileSheetKey) {
		setActive((current) => (current === key ? null : key));
	}

	return {
		active,
		close: () => setActive(null),
		toggleMenu: () => toggle("menu"),
		toggleFiles: () => toggle("files"),
		menuTriggerRef,
		filesTriggerRef,
		finalFocusRef:
			lastActiveRef.current === "files" ? filesTriggerRef : menuTriggerRef,
	};
}
