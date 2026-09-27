import { and, gt, isNotNull } from "drizzle-orm";
import { PROVIDER_CHARS_PER_TOKEN } from "../agents/providerConfig";
import { closeDb, getDb } from "../db";
import { usageEvents as usageEventsTable } from "../db/schema";
import {
	type CalibrationSample,
	recalibrateCharsPerToken,
	turnDrift,
} from "../sessions/charCalibration";

/**
 * The recorded measurement behind `PROVIDER_CHARS_PER_TOKEN` (issue #270,
 * ADR-0048): reads a real instance's `usage_events` — every turn carrying
 * both dilna's stamped estimate and the provider's reported context count
 * (#267/#270) — and recomputes each provider's `charsPerToken` by least
 * squares over the proportional estimator, alongside the mean signed drift
 * the current constant produces.
 *
 * Run against a deployed instance (its DB holds the real Sessions this
 * ships to justify the constants with):
 *
 *     DILNA_DATA_DIR=/path/to/instance-data \
 *       node --experimental-strip-types apps/server/src/scripts/measure-chars-per-token.ts
 *
 * (or `pnpm --filter @dilna/server exec tsx src/scripts/measure-chars-per-token.ts`).
 * Paste the recomputed constants into `PROVIDER_CHARS_PER_TOKEN` when they
 * have converged over enough turns — the units are turns, printed below.
 */

const MIN_TURNS = 30;

function main() {
	const db = getDb();
	const rows = db
		.select({
			provider: usageEventsTable.provider,
			estimated: usageEventsTable.estimatedContextTokens,
			reported: usageEventsTable.providerContextTokens,
		})
		.from(usageEventsTable)
		.where(
			and(
				isNotNull(usageEventsTable.estimatedContextTokens),
				isNotNull(usageEventsTable.providerContextTokens),
				gt(usageEventsTable.providerContextTokens, 0),
			),
		)
		.all() as CalibrationSample[];

	console.log(`comparable turns: ${rows.length}`);
	if (rows.length === 0) {
		console.log(
			"nothing to measure yet — both stamps need #267/#270 to have run real turns",
		);
		return;
	}

	const byProvider = new Map<string, CalibrationSample[]>();
	for (const row of rows) {
		const list = byProvider.get(row.provider) ?? [];
		list.push(row);
		byProvider.set(row.provider, list);
	}

	const recalibrated = recalibrateCharsPerToken(rows);
	for (const [provider, samples] of [...byProvider.entries()].sort()) {
		const shipped =
			PROVIDER_CHARS_PER_TOKEN[
				provider as keyof typeof PROVIDER_CHARS_PER_TOKEN
			] ?? undefined;
		const meanDrift =
			samples.reduce(
				(sum, s) => sum + (turnDrift(s.estimated, s.reported) ?? 0),
				0,
			) / samples.length;
		const measured = recalibrated[provider];
		console.log(
			`\n${provider} — ${samples.length} turns` +
				`(shipped constant: ${shipped ?? "custom/library default"})`,
			`\n  mean signed drift: ${(meanDrift * 100).toFixed(1)}%` +
				` (positive = dilna over-counts)`,
			`\n  least-squares constant: ${measured?.toFixed(2) ?? "n/a"}` +
				(measured !== undefined &&
				Math.abs(measured - (shipped ?? 4)) / (shipped ?? 4) > 0.1
					? "  ← more than 10% off the shipped constant, consider updating"
					: ""),
		);
		if (samples.length < MIN_TURNS) {
			console.log(
				`  (only ${samples.length} turns — below the ${MIN_TURNS}-turn floor; keep accumulating)`,
			);
		}
	}
}

main();
closeDb();
