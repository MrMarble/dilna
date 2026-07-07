import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "@/lib/theme";

function mockMatchMedia(prefersDark: boolean) {
	const listeners = new Set<(event: MediaQueryListEvent) => void>();
	const mql = {
		matches: prefersDark,
		media: "(prefers-color-scheme: dark)",
		addEventListener: (
			_: string,
			listener: (event: MediaQueryListEvent) => void,
		) => {
			listeners.add(listener);
		},
		removeEventListener: (
			_: string,
			listener: (event: MediaQueryListEvent) => void,
		) => {
			listeners.delete(listener);
		},
	};
	vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(mql));
	return {
		emit: (matches: boolean) => {
			mql.matches = matches;
			for (const listener of listeners) {
				listener({ matches } as MediaQueryListEvent);
			}
		},
	};
}

describe("useTheme", () => {
	beforeEach(() => {
		localStorage.clear();
		document.documentElement.classList.remove("dark");
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("defaults to the system preference when nothing is stored", () => {
		mockMatchMedia(true);
		const { result } = renderHook(() => useTheme());
		expect(result.current.theme).toBe("dark");
		expect(document.documentElement.classList.contains("dark")).toBe(true);
	});

	it("defaults to light when the system prefers light", () => {
		mockMatchMedia(false);
		const { result } = renderHook(() => useTheme());
		expect(result.current.theme).toBe("light");
		expect(document.documentElement.classList.contains("dark")).toBe(false);
	});

	it("prefers a stored theme over the system preference", () => {
		mockMatchMedia(false);
		localStorage.setItem("dilna-theme", "dark");
		const { result } = renderHook(() => useTheme());
		expect(result.current.theme).toBe("dark");
	});

	it("toggles the theme and persists the choice", () => {
		mockMatchMedia(false);
		const { result } = renderHook(() => useTheme());
		expect(result.current.theme).toBe("light");

		act(() => {
			result.current.toggleTheme();
		});

		expect(result.current.theme).toBe("dark");
		expect(document.documentElement.classList.contains("dark")).toBe(true);
		expect(localStorage.getItem("dilna-theme")).toBe("dark");
	});

	it("stops following system preference changes once toggled", () => {
		const { emit } = mockMatchMedia(false);
		const { result } = renderHook(() => useTheme());

		act(() => {
			result.current.toggleTheme();
		});
		expect(result.current.theme).toBe("dark");

		act(() => {
			emit(false);
		});
		expect(result.current.theme).toBe("dark");
	});

	it("follows live system preference changes until the user picks explicitly", () => {
		const { emit } = mockMatchMedia(false);
		const { result } = renderHook(() => useTheme());
		expect(result.current.theme).toBe("light");

		act(() => {
			emit(true);
		});
		expect(result.current.theme).toBe("dark");
	});
});
