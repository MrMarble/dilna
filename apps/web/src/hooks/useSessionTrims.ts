import type { ToolOutputTrim } from "@dilna/shared";
import { useEffect, useState } from "react";
import { api } from "@/api/client";

/**
 * Which of a Session's tool calls the seeder trims (issue #273), keyed by
 * the call id the persisted `tool_call` parts carry. Fetched once per
 * session — the trims are derived from persisted rows by the same walk the
 * seeder runs, so they only change when history does, and a reload recomput
 * es them exactly. Live turns' results are seeded verbatim, so there is
 * nothing to stream.
 */
export function useSessionTrims(
	sessionId: string,
): Map<string, ToolOutputTrim> {
	const [trims, setTrims] = useState<Map<string, ToolOutputTrim>>(new Map());

	useEffect(() => {
		setTrims(new Map());
		let cancelled = false;
		api.sessions
			.trims(sessionId)
			.then(({ trims: list }) => {
				if (cancelled) return;
				setTrims(new Map(list.map((t) => [t.callId, t])));
			})
			.catch(() => {
				// best-effort: an empty map renders no trim markers
			});
		return () => {
			cancelled = true;
		};
	}, [sessionId]);

	return trims;
}
