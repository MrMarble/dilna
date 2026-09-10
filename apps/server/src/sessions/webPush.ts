import {
	createCipheriv,
	createECDH,
	createHash,
	createPrivateKey,
	sign as cryptoSign,
	type ECDH,
	generateKeyPairSync,
	hkdfSync,
	randomBytes,
} from "node:crypto";

/**
 * Web Push protocol primitives (ADR-0029) — VAPID request signing (RFC 8292)
 * and `aes128gcm` payload encryption (RFC 8291), implemented directly on
 * `node:crypto`.
 *
 * Why not the `web-push` package: it was last published in January 2024 and
 * pulls five transitive dependencies (`asn1.js`, `http_ece`, `jws`,
 * `https-proxy-agent`, `minimist`) onto a security-sensitive path. Everything
 * the protocol needs — P-256 keygen, ES256 signing with raw (P1363) output,
 * ECDH, HKDF, AES-128-GCM — has been in Node's standard library for years, so
 * the whole surface is the two functions below.
 *
 * This module is deliberately transport-free and stateless: it turns keys and
 * a payload into headers and a body. Sending them, persisting keys, and
 * pruning dead subscriptions all live in pushSender.ts.
 */

/** A subscription's crypto material, as handed over by the browser. All
 * base64url, exactly as `PushSubscription.toJSON()` serializes them. */
export type PushKeys = {
	/** The subscriber's uncompressed P-256 public point. */
	p256dh: string;
	/** The subscriber's 16-byte shared auth secret. */
	auth: string;
};

export type VapidKeypair = {
	/** Uncompressed P-256 public point, base64url — this is what the browser
	 * receives as `applicationServerKey`. */
	publicKey: string;
	/** PKCS#8-encoded private key, base64url. */
	privateKey: string;
};

function b64urlEncode(buf: Buffer): string {
	return buf.toString("base64url");
}

function b64urlDecode(value: string): Buffer {
	return Buffer.from(value, "base64url");
}

/**
 * Generate a fresh VAPID keypair. Called once per instance, on first boot
 * (see pushSender.ts) — never on a schedule, since rotating the pair
 * invalidates every stored subscription.
 */
export function generateVapidKeys(): VapidKeypair {
	const { publicKey, privateKey } = generateKeyPairSync("ec", {
		namedCurve: "prime256v1",
	});
	// `jwk.x`/`jwk.y` are the raw coordinates; the uncompressed point the Push
	// API expects is 0x04 || X || Y.
	const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
	const point = Buffer.concat([
		Buffer.from([0x04]),
		b64urlDecode(jwk.x),
		b64urlDecode(jwk.y),
	]);
	return {
		publicKey: b64urlEncode(point),
		privateKey: b64urlEncode(
			privateKey.export({ format: "der", type: "pkcs8" }) as Buffer,
		),
	};
}

/**
 * Build the `Authorization` header for a push request (RFC 8292): a compact
 * ES256 JWT asserting who this application server is, scoped to the push
 * service's origin.
 *
 * `aud` must be the *origin* of the endpoint, not the full URL — push
 * services reject a token scoped to the complete path. `exp` is bounded to 12
 * hours; the spec caps it at 24, and a shorter window limits replay if a
 * token leaks.
 */
export function buildVapidHeader(
	endpoint: string,
	vapid: VapidKeypair,
	subject: string,
	nowMs: number = Date.now(),
): string {
	const audience = new URL(endpoint).origin;
	const header = b64urlEncode(
		Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })),
	);
	const body = b64urlEncode(
		Buffer.from(
			JSON.stringify({
				aud: audience,
				exp: Math.floor(nowMs / 1000) + 12 * 60 * 60,
				sub: subject,
			}),
		),
	);
	const signingInput = `${header}.${body}`;
	const key = createPrivateKey({
		key: b64urlDecode(vapid.privateKey),
		format: "der",
		type: "pkcs8",
	});
	// JWS requires the raw 64-byte (r||s) form, not the DER-wrapped signature
	// Node emits by default.
	const signature = cryptoSign("sha256", Buffer.from(signingInput), {
		key,
		dsaEncoding: "ieee-p1363",
	});
	return `vapid t=${signingInput}.${b64urlEncode(signature)}, k=${vapid.publicKey}`;
}

/**
 * Encrypt a payload for one subscription using the `aes128gcm` content
 * encoding (RFC 8291/8188).
 *
 * The shape of it: derive a shared secret with the subscriber via ECDH, mix
 * it with their `auth` secret to get an input keying material, then derive a
 * content key and nonce from that plus a random salt. The result is
 * self-describing — salt, record size, and our ephemeral public key are
 * prefixed to the ciphertext as a header block, so the recipient needs
 * nothing but their own private key to undo it.
 *
 * The single 0x02 byte appended to the plaintext is the record delimiter for
 * the final (only) record; without it the browser rejects the message.
 */
export function encryptPayload(
	payload: string,
	keys: PushKeys,
	salt: Buffer = randomBytes(16),
	ephemeral?: ECDH,
): Buffer {
	const subscriberPublic = b64urlDecode(keys.p256dh);
	const authSecret = b64urlDecode(keys.auth);

	// A caller-supplied ECDH is assumed already generated (tests pin it for
	// determinism); `getPublicKey()` throws rather than returning empty on an
	// ungenerated one, so there is nothing safe to probe here.
	let localEphemeral = ephemeral;
	if (!localEphemeral) {
		localEphemeral = createECDH("prime256v1");
		localEphemeral.generateKeys();
	}
	const localPublic = localEphemeral.getPublicKey();
	const sharedSecret = localEphemeral.computeSecret(subscriberPublic);

	// Per RFC 8291 §3.3 the key info binds both parties' public keys, which is
	// what stops a shared secret from being reused against another subscriber.
	const keyInfo = Buffer.concat([
		Buffer.from("WebPush: info\0"),
		subscriberPublic,
		localPublic,
	]);
	const ikm = Buffer.from(
		hkdfSync("sha256", sharedSecret, authSecret, keyInfo, 32),
	);

	const contentEncryptionKey = Buffer.from(
		hkdfSync(
			"sha256",
			ikm,
			salt,
			Buffer.from("Content-Encoding: aes128gcm\0"),
			16,
		),
	);
	const nonce = Buffer.from(
		hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12),
	);

	const cipher = createCipheriv("aes-128-gcm", contentEncryptionKey, nonce);
	const body = Buffer.concat([
		cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([0x02])])),
		cipher.final(),
		cipher.getAuthTag(),
	]);

	const recordSize = Buffer.alloc(4);
	recordSize.writeUInt32BE(4096, 0);
	return Buffer.concat([
		salt,
		recordSize,
		Buffer.from([localPublic.length]),
		localPublic,
		body,
	]);
}

/** Stable per-payload identity, used only to give the OS a replace-key. */
export function notificationTag(sessionId: string): string {
	return `dilna:${sessionId}`;
}

/** Short, deterministic fingerprint of an endpoint for logging — the full
 * endpoint is a capability URL and must not be written to logs. */
export function endpointFingerprint(endpoint: string): string {
	return createHash("sha256").update(endpoint).digest("hex").slice(0, 8);
}
