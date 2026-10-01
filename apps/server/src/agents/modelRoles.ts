import {
	MODEL_ROLES,
	type ModelRole,
	type ModelRoleAssignment,
} from "@dilna/shared";
import { eq, like } from "drizzle-orm";
import { getDb } from "../db";
import { llmConfig as llmConfigTable } from "../db/schema";
import { logger } from "../logger";
import { validateModelChoice } from "./providerConfigStore";

/**
 * Model roles (issue #308, ADR-0053 §1): named slots in Settings, each
 * pointing at one validated provider/model pair, so a consumer can ask for
 * "the cheap model" without knowing what cheap is. v1 has one role, `cheap`.
 *
 * Configuration, not provider machinery: a role reaches no model that
 * couldn't already be pinned, and every write goes through the same
 * {@link validateModelChoice} the Settings override and per-Session pinning
 * use. Stored as extra rows of `llm_config` (`id = "role:<name>"`), next to
 * the instance override's `"instance"` row — same columns, same
 * persist-across-restarts story, no new table.
 *
 * Unset by default, and unset changes nothing: {@link resolveModelRole}
 * answers "not configured" and every consumer falls back to what it did
 * before roles existed.
 */

const log = logger.child({ component: "agents/modelRoles" });

const ROLE_ROW_PREFIX = "role:";

function rowId(role: ModelRole): string {
	return `${ROLE_ROW_PREFIX}${role}`;
}

function isModelRole(value: string): value is ModelRole {
	return (MODEL_ROLES as readonly string[]).includes(value);
}

/**
 * In-memory mirror of the persisted role rows, primed at boot by
 * {@link primeModelRolesFromDb} and kept in sync on every write — same
 * pattern (and same reason: no DB hit on the hot path) as the override
 * cache in `providerConfigStore.ts`.
 */
let roleCache = new Map<ModelRole, ModelRoleAssignment>();

/** Load every persisted role row into the cache. Called once at boot. */
export function primeModelRolesFromDb(): void {
	const rows = getDb()
		.select()
		.from(llmConfigTable)
		.where(like(llmConfigTable.id, `${ROLE_ROW_PREFIX}%`))
		.all();
	const next = new Map<ModelRole, ModelRoleAssignment>();
	for (const row of rows) {
		const name = row.id.slice(ROLE_ROW_PREFIX.length);
		// A row for a role this build doesn't know, or a partial one, counts as
		// unset — the write path never stores either, so this is defensive.
		if (!isModelRole(name) || !row.provider || !row.model) continue;
		next.set(name, { provider: row.provider, model: row.model });
	}
	roleCache = next;
}

/** The role's stored assignment, or null when unset. Settings-facing: what
 * the user configured, not whether it still resolves. */
export function getModelRole(role: ModelRole): ModelRoleAssignment | null {
	return roleCache.get(role) ?? null;
}

/** Every role's stored assignment, for `GET /api/config`. */
export function listModelRoles(): Record<
	ModelRole,
	ModelRoleAssignment | null
> {
	return Object.fromEntries(
		MODEL_ROLES.map((role) => [role, getModelRole(role)]),
	) as Record<ModelRole, ModelRoleAssignment | null>;
}

export type SetModelRoleResult = { ok: true } | { ok: false; error: string };

/**
 * Validate and persist a role's assignment, replacing any existing one.
 * Rejected up front, with the same actionable messages as the override,
 * when the provider is unknown, the model isn't in its catalog, or no key
 * resolves — the DB never holds an assignment the resolver couldn't use.
 */
export async function setModelRole(
	role: ModelRole,
	provider: string,
	model: string,
): Promise<SetModelRoleResult> {
	const p = provider.trim();
	const m = model.trim();
	const choice = await validateModelChoice(p, m);
	if (!choice.ok) return choice;

	const updatedAt = Math.floor(Date.now() / 1000);
	getDb()
		.insert(llmConfigTable)
		.values({ id: rowId(role), provider: p, model: m, updatedAt })
		.onConflictDoUpdate({
			target: llmConfigTable.id,
			set: { provider: p, model: m, updatedAt },
		})
		.run();
	roleCache.set(role, { provider: p, model: m });
	return { ok: true };
}

/** Unset a role, so its consumers fall back to the Session's own model. */
export function clearModelRole(role: ModelRole): void {
	getDb()
		.delete(llmConfigTable)
		.where(eq(llmConfigTable.id, rowId(role)))
		.run();
	roleCache.delete(role);
}

export type ModelRoleResolution =
	| { status: "resolved"; provider: string; model: string }
	| { status: "unset" }
	| { status: "invalid"; error: string };

/**
 * The single entry point every role consumer uses (ADR-0053 §2): role name
 * → concrete validated pair, resolved **at execution time** — call it when
 * the work runs, never ahead of time, and never write what it returns into a
 * prompt or tool description. A role re-pointed in Settings then applies to
 * the very next call, and nothing a parent model reads goes stale.
 *
 * Re-validates on every call (provider still known, model still in its
 * catalog, key still resolvable) because any of those can change after the
 * role was set — a custom provider deleted, a key cleared. `"unset"` means
 * the caller falls back; `"invalid"` carries an actionable message and is
 * the caller's to surface or degrade on, per consumer.
 */
export async function resolveModelRole(
	role: ModelRole,
): Promise<ModelRoleResolution> {
	const assignment = getModelRole(role);
	if (!assignment) return { status: "unset" };
	const { provider, model } = assignment;
	const choice = await validateModelChoice(provider, model);
	if (!choice.ok) {
		return {
			status: "invalid",
			error: `The "${role}" model role is misconfigured — ${choice.error} Re-point the role in Settings.`,
		};
	}
	return { status: "resolved", provider, model };
}

export type ModelChoiceResolution =
	| {
			status: "resolved";
			provider: string;
			model: string;
			/** The role the choice named, or null for a concrete pair. */
			role: ModelRole | null;
	  }
	/** A known role that isn't configured: the caller runs on its own
	 * default, exactly as if no choice had been made (ADR-0053 §1). */
	| { status: "unset-role"; role: ModelRole }
	| { status: "invalid"; error: string };

/**
 * Resolve a model choice a *parent model* wrote into a tool call
 * (`dilna_create_session`'s and `task`'s `model` argument, issues
 * #309/#310): either a role name (`"cheap"`, preferred) or a concrete
 * `"provider/model"` pair. Split on the first `/` — role names never contain
 * one, provider ids never contain one, model ids may.
 *
 * Execution-time by construction (ADR-0053 §2): a role name in an old call
 * still means whatever the role points at *now*, so a stale argument in the
 * transcript can never pin an outdated model. A concrete pair is validated
 * exactly like a user-pinned Session. Every rejection carries a message the
 * parent model can act on in the same turn.
 */
export async function resolveModelChoice(
	raw: string,
): Promise<ModelChoiceResolution> {
	const choice = raw.trim();
	const slash = choice.indexOf("/");
	if (slash === -1) {
		if (!isModelRole(choice)) {
			return {
				status: "invalid",
				error: `"${choice}" is not a model role. Known roles: ${MODEL_ROLES.join(", ")}. Omit the model to use the default.`,
			};
		}
		const resolution = await resolveModelRole(choice);
		if (resolution.status === "unset") {
			return { status: "unset-role", role: choice };
		}
		if (resolution.status === "invalid") return resolution;
		return {
			status: "resolved",
			provider: resolution.provider,
			model: resolution.model,
			role: choice,
		};
	}
	const provider = choice.slice(0, slash).trim();
	const model = choice.slice(slash + 1).trim();
	const valid = await validateModelChoice(provider, model);
	if (!valid.ok) {
		return {
			status: "invalid",
			error: `${valid.error} Prefer a model role (${MODEL_ROLES.join(", ")}), or omit the model to use the default.`,
		};
	}
	return { status: "resolved", provider, model, role: null };
}

/**
 * The model the built-in utility calls — title derivation, compaction
 * summaries, the scoring judge — should run on (issue #311): the `cheap`
 * role when it resolves, else `null`, meaning "use the Session's own model,
 * exactly as before roles existed".
 *
 * A *misconfigured* role (provider gone, key cleared) also yields `null`,
 * logged: a utility call is never the place to surface a Settings error, and
 * falling back keeps compaction in particular from being blocked until
 * someone notices. A role that resolves but whose provider then fails at
 * call time is the consumer's to degrade on, the same way it degrades when
 * the Session's own model fails.
 */
export async function resolveUtilityModel(): Promise<{
	provider: string;
	model: string;
} | null> {
	const resolution = await resolveModelRole("cheap");
	if (resolution.status === "resolved") {
		return { provider: resolution.provider, model: resolution.model };
	}
	if (resolution.status === "invalid") {
		log.warn(
			{ error: resolution.error },
			"cheap model role is misconfigured — utility call falls back to the Session's model",
		);
	}
	return null;
}
