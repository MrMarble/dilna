import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useMobileSheet } from "@/hooks/useMobileSheet";

describe("useMobileSheet", () => {
	it("starts closed", () => {
		const { result } = renderHook(() => useMobileSheet());
		expect(result.current.active).toBeNull();
		expect(result.current.menuTrigger.open).toBe(false);
		expect(result.current.filesTrigger.open).toBe(false);
	});

	it("opens the menu sheet on menuTrigger.onToggle", () => {
		const { result } = renderHook(() => useMobileSheet());
		act(() => result.current.menuTrigger.onToggle());
		expect(result.current.active).toBe("menu");
		expect(result.current.menuTrigger.open).toBe(true);
		expect(result.current.filesTrigger.open).toBe(false);
	});

	it("opens the files sheet on filesTrigger.onToggle", () => {
		const { result } = renderHook(() => useMobileSheet());
		act(() => result.current.filesTrigger.onToggle());
		expect(result.current.active).toBe("files");
		expect(result.current.filesTrigger.open).toBe(true);
		expect(result.current.menuTrigger.open).toBe(false);
	});

	it("closes the sheet when the already-active icon is tapped again", () => {
		const { result } = renderHook(() => useMobileSheet());
		act(() => result.current.menuTrigger.onToggle());
		act(() => result.current.menuTrigger.onToggle());
		expect(result.current.active).toBeNull();
	});

	it("swaps content in place when the other icon is tapped, without closing first", () => {
		const { result } = renderHook(() => useMobileSheet());
		act(() => result.current.menuTrigger.onToggle());
		act(() => result.current.filesTrigger.onToggle());
		expect(result.current.active).toBe("files");
	});

	it("closes via close()", () => {
		const { result } = renderHook(() => useMobileSheet());
		act(() => result.current.filesTrigger.onToggle());
		act(() => result.current.close());
		expect(result.current.active).toBeNull();
	});

	it("keeps finalFocusRef pointed at the last active icon through close", () => {
		const { result } = renderHook(() => useMobileSheet());
		act(() => result.current.filesTrigger.onToggle());
		expect(result.current.finalFocusRef).toBe(result.current.filesTrigger.ref);
		act(() => result.current.filesTrigger.onToggle()); // closes
		expect(result.current.active).toBeNull();
		expect(result.current.finalFocusRef).toBe(result.current.filesTrigger.ref);
	});

	it("defaults finalFocusRef to the menu trigger before anything opens", () => {
		const { result } = renderHook(() => useMobileSheet());
		expect(result.current.finalFocusRef).toBe(result.current.menuTrigger.ref);
	});

	it("keeps stable callback identities across re-renders", () => {
		const { result, rerender } = renderHook(() => useMobileSheet());
		const { close, menuTrigger, filesTrigger } = result.current;
		rerender();
		expect(result.current.close).toBe(close);
		expect(result.current.menuTrigger.onToggle).toBe(menuTrigger.onToggle);
		expect(result.current.filesTrigger.onToggle).toBe(filesTrigger.onToggle);
	});
});
