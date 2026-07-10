import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useMobileSheet } from "@/hooks/useMobileSheet";

describe("useMobileSheet", () => {
	it("starts closed", () => {
		const { result } = renderHook(() => useMobileSheet());
		expect(result.current.active).toBeNull();
	});

	it("opens the menu sheet on toggleMenu", () => {
		const { result } = renderHook(() => useMobileSheet());
		act(() => result.current.toggleMenu());
		expect(result.current.active).toBe("menu");
	});

	it("opens the files sheet on toggleFiles", () => {
		const { result } = renderHook(() => useMobileSheet());
		act(() => result.current.toggleFiles());
		expect(result.current.active).toBe("files");
	});

	it("closes the sheet when the already-active icon is tapped again", () => {
		const { result } = renderHook(() => useMobileSheet());
		act(() => result.current.toggleMenu());
		act(() => result.current.toggleMenu());
		expect(result.current.active).toBeNull();
	});

	it("swaps content in place when the other icon is tapped, without closing first", () => {
		const { result } = renderHook(() => useMobileSheet());
		act(() => result.current.toggleMenu());
		act(() => result.current.toggleFiles());
		expect(result.current.active).toBe("files");
	});

	it("closes via close()", () => {
		const { result } = renderHook(() => useMobileSheet());
		act(() => result.current.toggleFiles());
		act(() => result.current.close());
		expect(result.current.active).toBeNull();
	});

	it("keeps finalFocusRef pointed at the last active icon through close", () => {
		const { result } = renderHook(() => useMobileSheet());
		act(() => result.current.toggleFiles());
		expect(result.current.finalFocusRef).toBe(result.current.filesTriggerRef);
		act(() => result.current.toggleFiles()); // closes
		expect(result.current.active).toBeNull();
		expect(result.current.finalFocusRef).toBe(result.current.filesTriggerRef);
	});

	it("defaults finalFocusRef to the menu trigger before anything opens", () => {
		const { result } = renderHook(() => useMobileSheet());
		expect(result.current.finalFocusRef).toBe(result.current.menuTriggerRef);
	});
});
