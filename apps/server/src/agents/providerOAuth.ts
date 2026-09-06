import { randomUUID } from "node:crypto";
import type {
	AuthEvent,
	OAuthCredential,
	ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { setProviderOAuthCredential } from "./providerCredentials";

/**
 * Interactive "Sign in with Claude" login (Anthropic OAuth — the only
 * dilna-allowlisted provider `pi-ai` ships an OAuth flow for; see
 * providerCredentials.ts's module doc comment for why the request path needs
 * no changes once a token is stored).
 *
 * `pi-ai`'s `anthropicOAuth.login(interaction)` is a single long-lived async
 * call built for a CLI: it notifies an `auth_url` to open in a browser, races
 * a local callback server (hardcoded to `http://localhost:53692/callback` —
 * only reachable when the browser and the process calling `login()` share a
 * machine) against `interaction.prompt()` resolving with a pasted-back
 * code/URL, and resolves once one of those wins. dilna is a server with a
 * separate web client, often on a different machine than the browser doing
 * the login, so the callback server will typically just time out unused —
 * that's fine, it's designed to fall back to the manual-paste path, which is
 * the one dilna actually drives.
 *
 * Because `login()` is one call spanning "show the user a URL" and "accept
 * what they paste back", and dilna has no persistent connection to the
 * browser across that gap, this module splits it across two HTTP requests:
 * {@link startAnthropicLogin} kicks off `login()` and returns as soon as the
 * `auth_url` is known; {@link completeAnthropicLogin} feeds the pasted
 * code/URL into the still-pending `login()` call and awaits its result.
 */

type PendingLogin = {
	createdAt: number;
	controller: AbortController;
	loginPromise: Promise<OAuthCredential>;
	/** Resolves once `login()` has actually called `interaction.prompt()`
	 * (capturing `resolvePrompt`/`rejectPrompt` below) — awaited by
	 * {@link completeAnthropicLogin} before it feeds in the pasted input, so a
	 * (practically impossible, but not contractually guaranteed) reordering
	 * inside `login()` can't drop the submission on the floor. */
	promptReady: Promise<void>;
	resolvePrompt: ((value: string) => void) | null;
	rejectPrompt: ((err: unknown) => void) | null;
};

const pendingLogins = new Map<string, PendingLogin>();

/** Pending logins older than this are abandoned (never completed) — swept
 * lazily on every start/complete call rather than via a timer. */
const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;
/** How long to wait for `login()` to produce an `auth_url` before giving up —
 * generous, since it involves a real (if fast) local `net.Server.listen`. */
const AUTH_URL_TIMEOUT_MS = 20_000;
/** How long to wait for the token exchange after a code is submitted. */
const COMPLETE_TIMEOUT_MS = 30_000;

function sweepStalePendingLogins(): void {
	const now = Date.now();
	for (const [id, pending] of pendingLogins) {
		if (now - pending.createdAt > PENDING_LOGIN_TTL_MS) {
			pending.controller.abort();
			pendingLogins.delete(id);
		}
	}
}

function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	message: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

export type StartLoginResult =
	| { ok: true; loginId: string; authUrl: string }
	| { ok: false; error: string };

/**
 * Begin an Anthropic OAuth login: starts `pi-ai`'s `login()` flow and
 * resolves as soon as it announces the URL to open, without waiting for the
 * login to actually complete (that happens in {@link completeAnthropicLogin}).
 */
export async function startAnthropicLogin(): Promise<StartLoginResult> {
	sweepStalePendingLogins();

	const oauth = anthropicProvider().auth.oauth;
	if (!oauth) {
		return {
			ok: false,
			error: "pi-ai's anthropic provider has no OAuth auth defined",
		};
	}

	const loginId = randomUUID();
	const controller = new AbortController();

	let resolveAuthUrl!: (url: string) => void;
	let rejectAuthUrl!: (err: unknown) => void;
	const authUrlPromise = new Promise<string>((resolve, reject) => {
		resolveAuthUrl = resolve;
		rejectAuthUrl = reject;
	});

	let resolvePromptReady!: () => void;
	const promptReady = new Promise<void>((resolve) => {
		resolvePromptReady = resolve;
	});

	const pending: PendingLogin = {
		createdAt: Date.now(),
		controller,
		// Assigned just below, before this is stored — `login()` isn't invoked
		// until after `pending` exists, so the interaction's closures can
		// reference it.
		loginPromise: undefined as unknown as Promise<OAuthCredential>,
		promptReady,
		resolvePrompt: null,
		rejectPrompt: null,
	};

	const interaction: ProviderAuthInteraction = {
		signal: controller.signal,
		notify(event: AuthEvent) {
			if (event.type === "auth_url") resolveAuthUrl(event.url);
		},
		prompt(promptSpec) {
			return new Promise<string>((resolve, reject) => {
				pending.resolvePrompt = resolve;
				pending.rejectPrompt = reject;
				resolvePromptReady();
				// `manual_code`'s own `signal` (distinct from the whole-flow
				// `interaction.signal`) aborts this one prompt if `login()`
				// itself cancels it (e.g. the callback server won the race) —
				// surface that as a rejection so a stuck `completeAnthropicLogin`
				// doesn't hang forever waiting on a prompt nobody's listening to
				// anymore.
				promptSpec.signal?.addEventListener(
					"abort",
					() => reject(new Error("login prompt was cancelled")),
					{ once: true },
				);
			});
		},
	};

	pending.loginPromise = oauth.login(interaction);
	// The manual-paste path is the one dilna drives; if the raced-against
	// local callback server wins instead (same machine as the browser), or if
	// login() fails outright before ever notifying a URL, don't leave
	// authUrlPromise dangling.
	pending.loginPromise.catch((err) => rejectAuthUrl(err));
	// Never surface as an unhandled rejection — real failures are observed via
	// completeAnthropicLogin's own await of this same promise.
	pending.loginPromise.catch(() => {});

	pendingLogins.set(loginId, pending);

	try {
		const authUrl = await withTimeout(
			authUrlPromise,
			AUTH_URL_TIMEOUT_MS,
			"Timed out waiting for Anthropic's login URL.",
		);
		return { ok: true, loginId, authUrl };
	} catch (err) {
		controller.abort();
		pendingLogins.delete(loginId);
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export type CompleteLoginResult = { ok: true } | { ok: false; error: string };

/**
 * Feed the code/redirect-URL the user pasted back into a still-pending login
 * (see `startAnthropicLogin`), then await the token exchange and persist the
 * resulting credential.
 */
export async function completeAnthropicLogin(
	loginId: string,
	input: string,
): Promise<CompleteLoginResult> {
	const pending = pendingLogins.get(loginId);
	if (!pending) {
		return {
			ok: false,
			error: "This login has expired or was already completed — start again.",
		};
	}

	try {
		await withTimeout(
			pending.promptReady,
			COMPLETE_TIMEOUT_MS,
			"Login flow was not ready to accept a code.",
		);
		if (!pending.resolvePrompt) {
			throw new Error("Login flow was not ready to accept a code.");
		}
		pending.resolvePrompt(input.trim());
		const credential = await withTimeout(
			pending.loginPromise,
			COMPLETE_TIMEOUT_MS,
			"Timed out exchanging the authorization code.",
		);
		setProviderOAuthCredential("anthropic", credential);
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err),
		};
	} finally {
		pendingLogins.delete(loginId);
	}
}

/** Abandon a pending login (e.g. the user closed the "Sign in with Claude"
 * dialog without pasting anything back). Idempotent. */
export function cancelAnthropicLogin(loginId: string): void {
	const pending = pendingLogins.get(loginId);
	if (!pending) return;
	pending.rejectPrompt?.(new Error("login cancelled"));
	pending.controller.abort();
	pendingLogins.delete(loginId);
}
