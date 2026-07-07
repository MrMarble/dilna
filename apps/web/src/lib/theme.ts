import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "dilna-theme";

function getSystemTheme(): Theme {
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

function getStoredTheme(): Theme | null {
	const stored = localStorage.getItem(STORAGE_KEY);
	return stored === "light" || stored === "dark" ? stored : null;
}

function getInitialTheme(): Theme {
	return getStoredTheme() ?? getSystemTheme();
}

function applyTheme(theme: Theme) {
	document.documentElement.classList.toggle("dark", theme === "dark");
}

/**
 * Resolves the active theme (defaulting to the OS preference) and exposes a
 * toggle that pins an explicit choice to localStorage. Once the user toggles,
 * we stop following system preference changes until they clear storage.
 */
export function useTheme() {
	const [theme, setTheme] = useState<Theme>(() => getInitialTheme());

	useEffect(() => {
		applyTheme(theme);
	}, [theme]);

	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = (event: MediaQueryListEvent) => {
			if (getStoredTheme()) return;
			setTheme(event.matches ? "dark" : "light");
		};
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, []);

	const toggleTheme = useCallback(() => {
		setTheme((current) => {
			const next: Theme = current === "dark" ? "light" : "dark";
			localStorage.setItem(STORAGE_KEY, next);
			return next;
		});
	}, []);

	return { theme, toggleTheme };
}
