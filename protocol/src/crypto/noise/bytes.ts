/**
 * Small, total, side-effect-free byte helpers used across the Noise core.
 *
 * They are intentionally trivial: keeping buffer arithmetic in one audited
 * place (rather than inline throughout the state machine) is part of the
 * "clear, no clever obscurity" security-review bar.
 */

const MAX_UINT64 = 2n ** 64n - 1n;

/** Concatenate byte chunks into a single freshly-allocated buffer. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Encode a 64-bit unsigned counter as 8 big-endian bytes. */
export function encodeUint64BE(value: bigint): Uint8Array {
  if (value < 0n || value > MAX_UINT64) {
    throw new RangeError("uint64 value out of range");
  }
  const out = new Uint8Array(8);
  let remaining = value;
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return out;
}

/** Decode 8 big-endian bytes at `offset` into a 64-bit unsigned counter. */
export function decodeUint64BE(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = 0; i < 8; i++) {
    value = (value << 8n) | BigInt(bytes[offset + i]);
  }
  return value;
}

/** Lower-case hex encoding (used for key serialization and test fixtures). */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return hex;
}

const HEX_BYTE_PATTERN = /^[0-9a-fA-F]{2}$/;

/** Decode a lower/upper-case hex string into bytes. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error("hex string must have an even length");
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const slice = hex.slice(i * 2, i * 2 + 2);
    if (!HEX_BYTE_PATTERN.test(slice)) {
      throw new Error("hex string contains a non-hex character");
    }
    out[i] = Number.parseInt(slice, 16);
  }
  return out;
}
