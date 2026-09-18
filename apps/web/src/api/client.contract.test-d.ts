import type {
	ListReposResponse,
	PushKeyResponse,
	SessionResponse,
} from "@dilna/shared";
import { describe, expectTypeOf, it } from "vitest";
import { api } from "./client";

/**
 * Type-level contract tests for the client's response envelopes (ADR-0040).
 *
 * These exist because the obvious guards do not actually hold. Naming a shared
 * envelope at the `request<...>` call site links the two sides only where some
 * consumer happens to *read* the field — narrowing
 * `request<SessionResponse>` back to `request<{ session }>` by hand compiles
 * cleanly, because dropping a field from a return type breaks nobody. A
 * runtime test does not catch it either: the value comes from a `fetch` mock,
 * so the field is present at runtime whatever the type says. That is precisely
 * how the three drifts in issue #231 survived.
 *
 * `expectTypeOf(...).toEqualTypeOf` is invariant, so it fails on a client type
 * that is merely *assignable* to the envelope — which is what a
 * hand-narrowed one is. Run by `vitest --typecheck` (`pnpm test:types`);
 * nothing here executes.
 */
describe("api client response envelopes", () => {
	it("types session creation as the full envelope, contextUsage included", () => {
		// Both of these used to be `{ session: SessionView }` while the server
		// had always sent `contextUsage` alongside it.
		expectTypeOf(
			api.sessions.create,
		).returns.resolves.toEqualTypeOf<SessionResponse>();
		expectTypeOf(
			api.sessions.createOrchestrator,
		).returns.resolves.toEqualTypeOf<SessionResponse>();
	});

	it("types the session fetch as the same envelope its creators return", () => {
		// The drift was once *within* this file: `get` declared `contextUsage`
		// and `create` beside it did not, for one server type.
		expectTypeOf(
			api.sessions.get,
		).returns.resolves.toEqualTypeOf<SessionResponse>();
	});

	it("types the push key response with its delivery health", () => {
		// `subscriptions`/`lastSuccessAt` reached the browser on every call but
		// were invisible to every consumer.
		expectTypeOf(
			api.push.key,
		).returns.resolves.toEqualTypeOf<PushKeyResponse>();
	});

	it("types a list endpoint as its shared envelope", () => {
		expectTypeOf(
			api.repos.list,
		).returns.resolves.toEqualTypeOf<ListReposResponse>();
	});
});
