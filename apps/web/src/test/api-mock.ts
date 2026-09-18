import type { api as RealApi } from "@/api/client";

/**
 * Type-checking for `vi.mock("@/api/client")` factories.
 *
 * The factory body passed to `vi.mock` is an ordinary object literal that
 * TypeScript never compares against the real module, so a mock can drift
 * from the client it stands in for and nothing complains. That is not
 * hypothetical: before this existed, `App.routing.test.tsx` mocked
 * `api.sessions.history` and `api.sessions.contextUsage` — neither of which
 * exists on the real client — plus a top-level `api.stream`, and returned a
 * `UsageSummary` missing its required `topSessions`. Four drifts in one file,
 * all invisible.
 *
 * Annotating the factory's *return* type catches missing and mistyped
 * members, but not extra ones: excess-property checking only applies to
 * direct object literals, and a factory return isn't one. `satisfies
 * PartialApi` on the object gets both, while `Partial` per group keeps a test
 * free to stub only the handful of endpoints it actually exercises rather
 * than all 17 session methods.
 *
 * Usage — note `satisfies`, not a type annotation:
 *
 * ```ts
 * vi.mock("@/api/client", () => ({
 *   api: {
 *     repos: { list: async () => ({ repos: [] }) },
 *   } satisfies PartialApi,
 * }));
 * ```
 *
 * A mock that also needs non-`api` exports (`ApiError`, `attachmentUrl`)
 * still spreads them in alongside; only the `api` object takes `satisfies`.
 */
export type Api = typeof RealApi;

/**
 * The real client's shape with every group and every method optional, so a
 * test stubs what it uses and no more — but anything it *does* stub is
 * checked against the real signature, and anything that isn't on the real
 * client is rejected.
 */
export type PartialApi = { [Group in keyof Api]?: Partial<Api[Group]> };
