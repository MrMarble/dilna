import { useEffect, useState } from "react";

/** localStorage-backed boolean, e.g. for a collapsed-panel preference that
 * should survive a reload. Falls back to `initial` when storage is
 * unavailable (private browsing) rather than throwing. */
export function usePersistedBoolean(key: string, initial = false) {
	const [value, setValue] = useState(() => {
		try {
			const stored = localStorage.getItem(key);
			return stored === null ? initial : stored === "1";
		} catch {
			return initial;
		}
	});

	useEffect(() => {
		try {
			localStorage.setItem(key, value ? "1" : "0");
		} catch {
			// ignore — see initial-read fallback above
		}
	}, [key, value]);

	return [value, setValue] as const;
}
