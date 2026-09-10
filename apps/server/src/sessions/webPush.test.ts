import {
	createDecipheriv,
	createECDH,
	createPublicKey,
	verify as cryptoVerify,
	hkdfSync,
} from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	buildVapidHeader,
	encryptPayload,
	endpointFingerprint,
	generateVapidKeys,
	notificationTag,
} from "./webPush";

/** Stand in for a subscribing browser: generate a P-256 keypair and an auth
 * secret the way the Push API does, then decrypt what the server produced. */
function makeSubscriber() {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	return {
		ecdh,
		keys: {
			p256dh: ecdh.getPublicKey().toString("base64url"),
			auth: Buffer.from([
				1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
			]).toString("base64url"),
		},
	};
}

/** The receiving half of RFC 8291, written independently of the sender so a
 * matching bug in both would have to be made twice. */
function decrypt(
	body: Buffer,
	subscriber: ReturnType<typeof makeSubscriber>,
): string {
	const salt = body.subarray(0, 16);
	const keyLength = body.readUInt8(20);
	const senderPublic = body.subarray(21, 21 + keyLength);
	const ciphertext = body.subarray(21 + keyLength);

	const sharedSecret = subscriber.ecdh.computeSecret(senderPublic);
	const authSecret = Buffer.from(subscriber.keys.auth, "base64url");
	const keyInfo = Buffer.concat([
		Buffer.from("WebPush: info\0"),
		subscriber.ecdh.getPublicKey(),
		senderPublic,
	]);
	const ikm = Buffer.from(
		hkdfSync("sha256", sharedSecret, authSecret, keyInfo, 32),
	);
	const key = Buffer.from(
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

	const tag = ciphertext.subarray(ciphertext.length - 16);
	const data = ciphertext.subarray(0, ciphertext.length - 16);
	const decipher = createDecipheriv("aes-128-gcm", key, nonce);
	decipher.setAuthTag(tag);
	const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
	// Strip the RFC 8188 record delimiter.
	return plaintext.subarray(0, plaintext.length - 1).toString();
}

describe("generateVapidKeys", () => {
	it("produces an uncompressed P-256 point and a usable private key", () => {
		const keys = generateVapidKeys();
		const point = Buffer.from(keys.publicKey, "base64url");
		expect(point.length).toBe(65);
		expect(point[0]).toBe(0x04);
		expect(Buffer.from(keys.privateKey, "base64url").length).toBeGreaterThan(0);
	});

	it("generates a distinct pair each call", () => {
		expect(generateVapidKeys().publicKey).not.toBe(
			generateVapidKeys().publicKey,
		);
	});
});

describe("buildVapidHeader", () => {
	it("signs a JWT that verifies against the advertised public key", () => {
		const vapid = generateVapidKeys();
		const header = buildVapidHeader(
			"https://fcm.googleapis.com/fcm/send/abc123",
			vapid,
			"mailto:ops@example.com",
		);

		const token = header.slice("vapid t=".length, header.indexOf(", k="));
		const advertised = header.slice(header.indexOf(", k=") + 4);
		expect(advertised).toBe(vapid.publicKey);

		const [encodedHeader, encodedBody, encodedSignature] = token.split(".") as [
			string,
			string,
			string,
		];
		const point = Buffer.from(vapid.publicKey, "base64url");
		const publicKey = createPublicKey({
			key: {
				kty: "EC",
				crv: "P-256",
				x: point.subarray(1, 33).toString("base64url"),
				y: point.subarray(33, 65).toString("base64url"),
			},
			format: "jwk",
		});

		const verified = cryptoVerify(
			"sha256",
			Buffer.from(`${encodedHeader}.${encodedBody}`),
			{ key: publicKey, dsaEncoding: "ieee-p1363" },
			Buffer.from(encodedSignature, "base64url"),
		);
		expect(verified).toBe(true);
	});

	it("scopes `aud` to the endpoint's origin, not its full path", () => {
		const vapid = generateVapidKeys();
		const header = buildVapidHeader(
			"https://fcm.googleapis.com/fcm/send/abc123",
			vapid,
			"mailto:ops@example.com",
		);
		const token = header.slice("vapid t=".length, header.indexOf(", k="));
		const claims = JSON.parse(
			Buffer.from(token.split(".")[1] as string, "base64url").toString(),
		);
		expect(claims.aud).toBe("https://fcm.googleapis.com");
		expect(claims.sub).toBe("mailto:ops@example.com");
	});

	it("bounds expiry to 12 hours ahead", () => {
		const vapid = generateVapidKeys();
		const nowMs = 1_700_000_000_000;
		const header = buildVapidHeader(
			"https://push.example.com/x",
			vapid,
			"mailto:ops@example.com",
			nowMs,
		);
		const token = header.slice("vapid t=".length, header.indexOf(", k="));
		const claims = JSON.parse(
			Buffer.from(token.split(".")[1] as string, "base64url").toString(),
		);
		expect(claims.exp).toBe(Math.floor(nowMs / 1000) + 12 * 60 * 60);
	});
});

describe("encryptPayload", () => {
	it("round-trips a payload the subscriber can decrypt", () => {
		const subscriber = makeSubscriber();
		const payload = JSON.stringify({
			title: "dilna · Session",
			body: "Agent finished the turn.",
		});
		const body = encryptPayload(payload, subscriber.keys);
		expect(decrypt(body, subscriber)).toBe(payload);
	});

	it("emits the RFC 8188 header block: salt, record size, sender key", () => {
		const subscriber = makeSubscriber();
		const body = encryptPayload("hi", subscriber.keys);
		expect(body.subarray(0, 16).length).toBe(16);
		expect(body.readUInt32BE(16)).toBe(4096);
		expect(body.readUInt8(20)).toBe(65);
		expect(body.readUInt8(21)).toBe(0x04);
	});

	it("produces different ciphertext each call for the same input", () => {
		const subscriber = makeSubscriber();
		const a = encryptPayload("same", subscriber.keys);
		const b = encryptPayload("same", subscriber.keys);
		expect(a.equals(b)).toBe(false);
		expect(decrypt(a, subscriber)).toBe("same");
		expect(decrypt(b, subscriber)).toBe("same");
	});

	it("handles a multi-byte UTF-8 payload", () => {
		const subscriber = makeSubscriber();
		const payload = "türn ✓ 完了";
		expect(decrypt(encryptPayload(payload, subscriber.keys), subscriber)).toBe(
			payload,
		);
	});

	it("fails to decrypt with a different subscriber's key", () => {
		const subscriber = makeSubscriber();
		const impostor = makeSubscriber();
		const body = encryptPayload("secret", subscriber.keys);
		expect(() => decrypt(body, impostor)).toThrow();
	});
});

describe("helpers", () => {
	it("tags notifications per session so the OS replaces rather than stacks", () => {
		expect(notificationTag("abc")).toBe("dilna:abc");
	});

	it("fingerprints an endpoint without leaking it", () => {
		const endpoint = "https://fcm.googleapis.com/fcm/send/secret-token";
		const fingerprint = endpointFingerprint(endpoint);
		expect(fingerprint).toHaveLength(8);
		expect(endpoint).not.toContain(fingerprint);
		expect(endpointFingerprint(endpoint)).toBe(fingerprint);
	});
});
