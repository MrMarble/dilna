import { type RefObject, useCallback, useRef, useState } from "react";

export type MobileSheetKey = "menu" | "files";

export type MobileSheetTrigger = {
	ref: RefObject<HTMLButtonElement | null>;
	open: boolean;
	onToggle: () => void;
};

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

	const toggle = useCallback((key: MobileSheetKey) => {
		setActive((current) => (current === key ? null : key));
	}, []);
	const close = useCallback(() => setActive(null), []);
	const toggleMenu = useCallback(() => toggle("menu"), [toggle]);
	const toggleFiles = useCallback(() => toggle("files"), [toggle]);

	return {
		active,
		close,
		menuTrigger: {
			ref: menuTriggerRef,
			open: active === "menu",
			onToggle: toggleMenu,
		} satisfies MobileSheetTrigger,
		filesTrigger: {
			ref: filesTriggerRef,
			open: active === "files",
			onToggle: toggleFiles,
		} satisfies MobileSheetTrigger,
		finalFocusRef:
			lastActiveRef.current === "files" ? filesTriggerRef : menuTriggerRef,
	};
}
