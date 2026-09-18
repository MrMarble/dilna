/**
 * The snapshot tag that anchors a hashline edit (issue #138, item 1).
 *
 * A 4-uppercase-hex digest of a file's *content*, minted when the Agent reads
 * the file and echoed back when it edits it. If the file changed in between,
 * the tag no longer matches and the edit is refused instead of being applied
 * to bytes the Agent never saw — see `hashlineEdit.ts`.
 *
 * Ported from oh-my-pi's `file_hash` (`crates/pi-edit/src/store.rs`), which is
 * itself just:
 *
 *     // strip BOM, normalize to LF, trim trailing ' '/'\t'/'\r' per line
 *     format!("{:04X}", xxh32(normalized.as_bytes(), 0) & 0xffff)
 *
 * Kept byte-compatible with omp deliberately: the tag is a shared vocabulary
 * between a read and a later edit, and `hashlineTag.test.ts` pins the three
 * vectors from omp's own tests. Diverging would be invisible until an edit was
 * refused for no visible reason.
 *
 * Two deliberate properties fall out of the normalization, both matching omp:
 * trailing whitespace and CRLF/BOM differences do *not* invalidate a tag
 * (nobody wants a refusal because an editor added a trailing space), while any
 * change to line content does.
 *
 * Why hand-rolled XXH32 rather than a dependency: Node's `crypto` has no
 * xxhash digest, dilna has no xxhash package, and this is ~40 lines of integer
 * math with published test vectors. A dependency would be more to audit than
 * the algorithm is to read.
 */

// XXH32 primes, from the reference implementation.
const PRIME32_1 = 0x9e3779b1;
const PRIME32_2 = 0x85ebca77;
const PRIME32_3 = 0xc2b2ae3d;
const PRIME32_4 = 0x27d4eb2f;
const PRIME32_5 = 0x165667b1;

/** JS bitwise ops are signed 32-bit; keep every intermediate unsigned so the
 * multiplications and rotations match Rust's `u32` behaviour. */
const u32 = (value: number): number => value >>> 0;

function rotl(value: number, bits: number): number {
	return u32((value << bits) | (value >>> (32 - bits)));
}

/** XXH32 (seed 0) over a byte buffer. */
function xxh32(bytes: Uint8Array): number {
	const length = bytes.length;
	let offset = 0;
	let hash: number;

	if (length >= 16) {
		let v1 = u32(PRIME32_1 + PRIME32_2);
		let v2 = u32(PRIME32_2);
		let v3 = 0;
		let v4 = u32(0 - PRIME32_1);

		const round = (accumulator: number, lane: number) =>
			u32(
				Math.imul(
					rotl(u32(accumulator + Math.imul(lane, PRIME32_2)), 13),
					PRIME32_1,
				),
			);
		const lane = (at: number) =>
			u32(
				(bytes[at] as number) |
					((bytes[at + 1] as number) << 8) |
					((bytes[at + 2] as number) << 16) |
					((bytes[at + 3] as number) << 24),
			);

		const limit = length - 16;
		while (offset <= limit) {
			v1 = round(v1, lane(offset));
			offset += 4;
			v2 = round(v2, lane(offset));
			offset += 4;
			v3 = round(v3, lane(offset));
			offset += 4;
			v4 = round(v4, lane(offset));
			offset += 4;
		}

		hash = u32(rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18));
	} else {
		hash = u32(PRIME32_5);
	}

	hash = u32(hash + length);

	while (offset + 4 <= length) {
		const lane = u32(
			(bytes[offset] as number) |
				((bytes[offset + 1] as number) << 8) |
				((bytes[offset + 2] as number) << 16) |
				((bytes[offset + 3] as number) << 24),
		);
		hash = u32(
			Math.imul(rotl(u32(hash + Math.imul(lane, PRIME32_3)), 17), PRIME32_4),
		);
		offset += 4;
	}

	while (offset < length) {
		hash = u32(
			Math.imul(
				rotl(u32(hash + Math.imul(bytes[offset] as number, PRIME32_5)), 11),
				PRIME32_1,
			),
		);
		offset += 1;
	}

	hash ^= hash >>> 15;
	hash = u32(Math.imul(hash, PRIME32_2));
	hash ^= hash >>> 13;
	hash = u32(Math.imul(hash, PRIME32_3));
	hash ^= hash >>> 16;
	return u32(hash);
}

/**
 * Normalize file text the way omp's `file_hash` does: drop a leading BOM,
 * collapse CRLF/CR to LF, and trim trailing spaces/tabs from every line while
 * keeping the newline itself.
 */
function normalize(text: string): string {
	const withoutBom = text.startsWith("\uFEFF") ? text.slice(1) : text;
	const lfOnly = withoutBom.replace(/\r\n?/g, "\n");
	return lfOnly
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/, ""))
		.join("\n");
}

/**
 * The 4-uppercase-hex tag for `text`.
 *
 * Callers should treat this as opaque: only equality with a tag minted from
 * the same file matters. It is deliberately *not* a security primitive — 16
 * bits collide readily, and its job is catching "this file moved under me",
 * not resisting anyone who wants a collision.
 */
export function hashlineTag(text: string): string {
	const digest = xxh32(Buffer.from(normalize(text), "utf8"));
	return (digest & 0xffff).toString(16).toUpperCase().padStart(4, "0");
}
