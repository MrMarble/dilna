import pino from "pino";

/**
 * Structured logging (issue #151), replacing hand-rolled `console.*` calls
 * with `[component] ...` prefixes. `logger` is the root; call sites get a
 * per-subsystem logger via `logger.child({ component: "sessions" })` so
 * fields like a session/repo id sit alongside the message as queryable JSON
 * rather than being interpolated into a string.
 *
 * Format auto-detects: pretty/colorized when stdout is a TTY (local `pnpm
 * dev`), else newline-delimited JSON (containers, anything piped to a log
 * collector) — overridable via `DILNA_LOG_FORMAT=pretty|json` for a case the
 * heuristic gets wrong (e.g. `docker run -it` during local debugging).
 * `pino-pretty` is a devDependency, not shipped in the production image (see
 * Dockerfile's `pnpm install --prod`) — safe only because the JSON path
 * never touches it, which the TTY-off default in a container guarantees.
 *
 * `redact` is a backstop, not the primary defense, against ever logging a
 * credential: ADR-0005/ADR-0013's provider/GH_TOKEN plumbing already avoids
 * logging secret values by construction, but a logger that enforces it (vs.
 * "nobody accidentally console.log'd one") is what issue #151 asked for.
 */

const explicitFormat = process.env.DILNA_LOG_FORMAT;
const pretty =
	explicitFormat === "pretty" ||
	(explicitFormat !== "json" && Boolean(process.stdout.isTTY));

export const logger = pino({
	level: process.env.DILNA_LOG_LEVEL ?? "info",
	serializers: { err: pino.stdSerializers.err },
	redact: {
		paths: [
			"apiKey",
			"*.apiKey",
			"token",
			"*.token",
			"accessToken",
			"*.accessToken",
			"refreshToken",
			"*.refreshToken",
			"authorization",
			"*.authorization",
			"req.headers.authorization",
		],
		censor: "[redacted]",
	},
	...(pretty
		? {
				transport: {
					target: "pino-pretty",
					options: {
						colorize: true,
						translateTime: "HH:MM:ss",
						ignore: "pid,hostname",
					},
				},
			}
		: {}),
});
