import type { AgentStreamEvent } from "@dilna/shared";
import { describe, expect, it, vi } from "vitest";
import {
	SESSION_EVENT_TYPES,
	SessionStreamHub,
	type SessionStreamTransport,
} from "./sessionStream";

/** A fake transport standing in for the `EventSource`, exposing handles to
 * drive open/event/connection-change per opened connection. */
type FakeConnection = {
	sessionId: string;
	eventTypes: readonly string[];
	emit: (event: AgentStreamEvent) => void;
	open: () => void;
	setConnected: (connected: boolean) => void;
	close: ReturnType<typeof vi.fn>;
};

function fakeTransport() {
	const opens: FakeConnection[] = [];

	const transport: SessionStreamTransport = (
		sessionId,
		eventTypes,
		onEvent,
		onOpen,
		onConnectionChange,
	) => {
		const close = vi.fn();
		opens.push({
			sessionId,
			eventTypes,
			emit: onEvent,
			open: onOpen,
			setConnected: onConnectionChange,
			close,
		});
		return close;
	};

	/** The nth opened connection, asserting it exists — keeps the tests free
	 * of non-null assertions under `noUncheckedIndexedAccess`. */
	const opened = (index = 0): FakeConnection => {
		const connection = opens[index];
		if (!connection) throw new Error(`no connection opened at ${index}`);
		return connection;
	};

	return { transport, opens, opened };
}

const status = (s: "working" | "idle"): AgentStreamEvent => ({
	type: "session_status",
	status: s,
});

describe("SESSION_EVENT_TYPES", () => {
	// The regression this guards: both were consumed by hooks/panels but
	// missing from the old hand-written array, so no listener was registered.
	it("covers every event type consumers rely on", () => {
		expect(SESSION_EVENT_TYPES).toContain("context_usage");
		expect(SESSION_EVENT_TYPES).toContain("artefact_published");
	});

	it("has no duplicates", () => {
		expect(new Set(SESSION_EVENT_TYPES).size).toBe(SESSION_EVENT_TYPES.length);
	});
});

describe("SessionStreamHub", () => {
	it("opens one connection for many subscribers to a session", () => {
		const { transport, opens, opened } = fakeTransport();
		const hub = new SessionStreamHub(transport);

		hub.subscribe("s1", {});
		hub.subscribe("s1", {});
		hub.subscribe("s1", {});
		hub.subscribe("s1", {});

		expect(opens).toHaveLength(1);
		expect(opened().sessionId).toBe("s1");
	});

	it("keeps separate connections per session", () => {
		const { transport, opens } = fakeTransport();
		const hub = new SessionStreamHub(transport);

		hub.subscribe("s1", {});
		hub.subscribe("s2", {});

		expect(opens.map((o) => o.sessionId)).toEqual(["s1", "s2"]);
		expect(hub.openSessionIds).toEqual(["s1", "s2"]);
	});

	it("fans one event out to every subscriber", () => {
		const { transport, opened } = fakeTransport();
		const hub = new SessionStreamHub(transport);
		const a = vi.fn();
		const b = vi.fn();

		hub.subscribe("s1", { onEvent: a });
		hub.subscribe("s1", { onEvent: b });
		opened().emit(status("working"));

		expect(a).toHaveBeenCalledWith(status("working"));
		expect(b).toHaveBeenCalledWith(status("working"));
	});

	it("does not deliver a session's events to another session's subscriber", () => {
		const { transport, opened } = fakeTransport();
		const hub = new SessionStreamHub(transport);
		const other = vi.fn();

		hub.subscribe("s1", { onEvent: vi.fn() });
		hub.subscribe("s2", { onEvent: other });
		opened().emit(status("working"));

		expect(other).not.toHaveBeenCalled();
	});

	it("closes the connection only when the last subscriber leaves", () => {
		const { transport, opened } = fakeTransport();
		const hub = new SessionStreamHub(transport);

		const first = hub.subscribe("s1", {});
		const second = hub.subscribe("s1", {});

		first();
		expect(opened().close).not.toHaveBeenCalled();
		expect(hub.openSessionIds).toEqual(["s1"]);

		second();
		expect(opened().close).toHaveBeenCalledTimes(1);
		expect(hub.openSessionIds).toEqual([]);
	});

	it("stops delivering to an unsubscribed consumer", () => {
		const { transport, opened } = fakeTransport();
		const hub = new SessionStreamHub(transport);
		const gone = vi.fn();
		const stays = vi.fn();

		const unsubscribe = hub.subscribe("s1", { onEvent: gone });
		hub.subscribe("s1", { onEvent: stays });
		unsubscribe();
		opened().emit(status("idle"));

		expect(gone).not.toHaveBeenCalled();
		expect(stays).toHaveBeenCalledTimes(1);
	});

	it("tolerates a double unsubscribe without dropping live subscribers", () => {
		const { transport, opened } = fakeTransport();
		const hub = new SessionStreamHub(transport);
		const stays = vi.fn();

		const unsubscribe = hub.subscribe("s1", {});
		hub.subscribe("s1", { onEvent: stays });
		unsubscribe();
		unsubscribe();

		expect(opened().close).not.toHaveBeenCalled();
		opened().emit(status("idle"));
		expect(stays).toHaveBeenCalledTimes(1);
	});

	it("reopens after the last subscriber left", () => {
		const { transport, opens } = fakeTransport();
		const hub = new SessionStreamHub(transport);

		hub.subscribe("s1", {})();
		hub.subscribe("s1", {});

		expect(opens).toHaveLength(2);
	});

	it("gives every subscriber the same resync on connect", () => {
		const { transport, opened } = fakeTransport();
		const hub = new SessionStreamHub(transport);
		const a = vi.fn();
		const b = vi.fn();

		hub.subscribe("s1", { onOpen: a });
		hub.subscribe("s1", { onOpen: b });
		opened().open();

		expect(a).toHaveBeenCalledTimes(1);
		expect(b).toHaveBeenCalledTimes(1);
	});

	// Join order must not decide whether a consumer ever resyncs: a panel
	// mounted mid-turn missed everything before it subscribed, exactly like a
	// reconnecting one.
	it("resyncs a late subscriber immediately on an open connection", () => {
		const { transport, opened } = fakeTransport();
		const hub = new SessionStreamHub(transport);

		hub.subscribe("s1", {});
		opened().open();

		const late = vi.fn();
		const lateConnection = vi.fn();
		hub.subscribe("s1", { onOpen: late, onConnectionChange: lateConnection });

		expect(late).toHaveBeenCalledTimes(1);
		expect(lateConnection).toHaveBeenCalledWith(true);
	});

	it("does not resync a late subscriber before the connection opens", () => {
		const { transport } = fakeTransport();
		const hub = new SessionStreamHub(transport);

		hub.subscribe("s1", {});
		const late = vi.fn();
		hub.subscribe("s1", { onOpen: late });

		expect(late).not.toHaveBeenCalled();
	});

	it("does not resync a late subscriber while the connection is degraded", () => {
		const { transport, opened } = fakeTransport();
		const hub = new SessionStreamHub(transport);

		hub.subscribe("s1", {});
		opened().open();
		opened().setConnected(false);

		const late = vi.fn();
		hub.subscribe("s1", { onOpen: late });
		expect(late).not.toHaveBeenCalled();
	});

	// The divergence issue #202 called the sharpest edge: one answer to "am I
	// connected?", not one opinion per socket.
	it("reports one connection state to every subscriber", () => {
		const { transport, opened } = fakeTransport();
		const hub = new SessionStreamHub(transport);
		const a = vi.fn();
		const b = vi.fn();

		hub.subscribe("s1", { onConnectionChange: a });
		hub.subscribe("s1", { onConnectionChange: b });
		opened().setConnected(false);
		opened().setConnected(true);

		expect(a.mock.calls).toEqual([[false], [true]]);
		expect(b.mock.calls).toEqual([[false], [true]]);
	});

	it("registers listeners for every event type", () => {
		const { transport, opened } = fakeTransport();
		const hub = new SessionStreamHub(transport);

		hub.subscribe("s1", {});
		expect(opened().eventTypes).toEqual(SESSION_EVENT_TYPES);
	});

	it("delivers to subscribers added by another subscriber's handler", () => {
		const { transport, opened } = fakeTransport();
		const hub = new SessionStreamHub(transport);
		const added = vi.fn();

		hub.subscribe("s1", {
			onEvent: () => {
				hub.subscribe("s1", { onEvent: added });
			},
		});
		opened().emit(status("working"));
		opened().emit(status("idle"));

		// Not on the event that added it, but on the next one.
		expect(added).toHaveBeenCalledTimes(1);
	});

	// ChatShell's `resync` unsubscribes and resubscribes; that must not skip
	// or double-deliver for the subscribers alongside it.
	it("survives a subscriber unsubscribing during dispatch", () => {
		const { transport, opened } = fakeTransport();
		const hub = new SessionStreamHub(transport);
		const other = vi.fn();

		const unsubscribe = hub.subscribe("s1", {
			onEvent: () => unsubscribe(),
		});
		hub.subscribe("s1", { onEvent: other });
		opened().emit(status("working"));

		expect(other).toHaveBeenCalledTimes(1);
	});
});
