import { useCallback, useEffect, useRef, useState } from "react";

/** Trailing debounce for draft writes — long enough to not hammer
 * localStorage on every keystroke, short enough that a draft is rarely more
 * than a syllable behind (and `pagehide`/unmount flush the remainder). */
const WRITE_DEBOUNCE_MS = 400;

const draftKey = (sessionId: string) => `dilna:draft:${sessionId}`;

/** All storage access is wrapped — localStorage can throw in private
 * browsing or when full, and a draft is never worth an error surface. */
function readDraft(sessionId: string): string {
	try {
		return localStorage.getItem(draftKey(sessionId)) ?? "";
	} catch {
		return "";
	}
}

function writeDraft(sessionId: string, value: string) {
	try {
		// A blank draft is removed rather than stored, so abandoned composers
		// don't leave empty entries behind.
		if (value.trim() === "") localStorage.removeItem(draftKey(sessionId));
		else localStorage.setItem(draftKey(sessionId), value);
	} catch {
		// ignore — the in-memory value still works for this page's lifetime
	}
}

/** Drop a Session's persisted draft. Exported separately from the hook so
 * App.tsx's delete-Session handler can clean up without mounting a composer
 * for the dying Session. */
export function clearSessionDraft(sessionId: string) {
	try {
		localStorage.removeItem(draftKey(sessionId));
	} catch {
		// ignore
	}
}

/**
 * The composer's input state, persisted per Session (issue: navigating to
 * another Session/Settings/Metrics unmounted ChatShell and lost the typed
 * text). localStorage-backed like `usePersistedBoolean` — local-only on
 * purpose, no cross-device sync (a draft is a this-browser affair; syncing
 * it would need a server round-trip and conflict story nobody asked for).
 *
 * Writes are debounced on change rather than saved only on unmount: a hard
 * reload or tab close never runs unmount effects, and the requirement is
 * that reload restores the draft too. The debounce remainder is flushed on
 * unmount, on Session switch, and on `pagehide`.
 *
 * Orchestrator Sessions share ChatShell and its `sessionId` prop, so their
 * drafts key the same way with no extra handling.
 */
export function useSessionDraft(sessionId: string) {
	const [value, setValueState] = useState(() => readDraft(sessionId));

	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	/** The not-yet-written draft, tagged with its Session — so a flush that
	 * runs after a Session switch still writes under the *old* key. */
	const pendingRef = useRef<{ sessionId: string; value: string } | null>(null);

	const flush = useCallback(() => {
		if (timerRef.current !== null) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		if (pendingRef.current) {
			writeDraft(pendingRef.current.sessionId, pendingRef.current.value);
			pendingRef.current = null;
		}
	}, []);

	// ChatShell is not remounted on Session switch (only its effects re-key
	// on sessionId), so the swap to the new Session's draft happens here via
	// the adjust-state-during-render pattern — an effect-based restore would
	// paint one frame of the previous Session's text first. The previous
	// Session's pending write is untouched: the cleanup effect below flushes
	// it under its own key.
	const [renderedFor, setRenderedFor] = useState(sessionId);
	if (renderedFor !== sessionId) {
		setRenderedFor(sessionId);
		setValueState(readDraft(sessionId));
	}

	const setValue = useCallback(
		(next: string) => {
			setValueState(next);
			pendingRef.current = { sessionId, value: next };
			if (timerRef.current !== null) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(flush, WRITE_DEBOUNCE_MS);
		},
		[sessionId, flush],
	);

	/** Discard the draft — state, pending write, and stored key — once the
	 * text has actually been accepted by the server (or is otherwise moot).
	 * Distinct from `setValue("")` only in immediacy: no debounce window in
	 * which a reload could resurrect the sent message. */
	const clear = useCallback(() => {
		if (timerRef.current !== null) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		pendingRef.current = null;
		setValueState("");
		clearSessionDraft(sessionId);
	}, [sessionId]);

	// Flush the debounce remainder when this Session's composer goes away —
	// unmount (navigation to Settings/Metrics/home) or Session switch. Keyed
	// on sessionId: the switch itself must flush, or a keystroke in the new
	// Session would overwrite `pendingRef` and drop the old Session's tail.
	// The cleanup runs after `pendingRef` was tagged, so it writes under the
	// old Session's key regardless.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `sessionId` is deliberately "extra" — it re-keys the cleanup so a Session switch flushes, not just unmount.
	useEffect(() => flush, [sessionId, flush]);

	// …and on `pagehide`, since unmount effects never run on a tab close or
	// hard reload. `pagehide` rather than `beforeunload`: it also fires when
	// a mobile browser freezes the page, and it doesn't break bfcache.
	useEffect(() => {
		window.addEventListener("pagehide", flush);
		return () => window.removeEventListener("pagehide", flush);
	}, [flush]);

	return { value, setValue, clear };
}
