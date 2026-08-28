import type { AgentStreamEvent, Message, Repo, Session } from "@dilna/shared";

/**
 * Renders a Session's full durable history as one plain-text/Markdown
 * document — for the "copy this link, hand it to another agent" export flow.
 * Reuses exactly what's already persisted (`messages.parts_json` carries
 * full tool_call input/output, per the DB-is-source-of-truth rule — no
 * separate summarized view to keep in sync) plus, best-effort, the last
 * `turn_failed` if it's still in memory (see
 * `SessionManager.getLastTurnFailed` — deliberately not durable, ADR-0016
 * §2, so a crash from a prior server run won't show up here).
 */
export function renderTranscript(
	session: Session,
	repo: Repo,
	messages: Message[],
	lastTurnFailed?: Extract<AgentStreamEvent, { type: "turn_failed" }>,
): string {
	const lines: string[] = [];
	const push = (line = "") => lines.push(line);

	push(`# ${session.title}`);
	push();
	push(`- Repo: ${repo.slug} (branch \`${session.branchName}\`)`);
	push(`- Session: ${session.id}`);
	push(`- Status: ${session.status}`);
	push(`- Created: ${isoOf(session.createdAt)}`);
	push(`- Last active: ${isoOf(session.lastActiveAt)}`);
	push(
		`- Tokens: ${session.usage.inputTokens} in / ${session.usage.outputTokens} out`,
	);
	push();

	if (session.status === "crashed") {
		push("## Last failure");
		push();
		if (lastTurnFailed) {
			push(`- Class: ${lastTurnFailed.class}`);
			push(`- Message: ${lastTurnFailed.message}`);
			if (lastTurnFailed.detail?.exitCode !== undefined) {
				push(`- Exit code: ${lastTurnFailed.detail.exitCode}`);
			}
			if (lastTurnFailed.detail?.stderrTail?.length) {
				push("- stderr tail:");
				push("```");
				for (const line of lastTurnFailed.detail.stderrTail) push(line);
				push("```");
			}
		} else {
			push(
				"_Failure detail wasn't retained — it's held in memory only " +
					"(ADR-0016 §2) and is lost once the session takes another turn " +
					"or the server restarts. Export right after a crash to catch it._",
			);
		}
		push();
	}

	push("## Transcript");
	push();

	if (messages.length === 0) {
		push("_No messages yet._");
	}

	for (const message of messages) {
		push(
			`### ${message.role === "user" ? "User" : "Assistant"} · ${isoOf(message.createdAt)}`,
		);
		push();
		for (const part of message.parts) {
			if (part.type === "text") {
				if (part.text.trim()) push(part.text.trim());
				push();
				continue;
			}
			push(`**Tool call: \`${part.tool}\`** (\`${part.callId}\`)`);
			push();
			push("Input:");
			push("```json");
			push(stringify(part.input));
			push("```");
			push();
			push(part.error ? "Error:" : "Output:");
			push(`\`\`\`${part.error ? "" : "json"}`);
			push(part.error ? part.error : stringify(part.output));
			push("```");
			push();
		}
	}

	return lines.join("\n");
}

function isoOf(epochSeconds: number): string {
	return new Date(epochSeconds * 1000).toISOString();
}

function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? "null";
	} catch {
		return String(value);
	}
}
