/** Cryptographic primitives for the Noise suite. */

import { x25519 } from "@noble/curves/ed25519.js";
import { concatBytes, encodeUint64BE } from "./bytes";
import { TAG_LEN } from "./constants";
import type { NoiseKeyPair } from "./types";

const subtle = globalThis.crypto.subtle;

const AES_GCM_TAG_BITS = TAG_LEN * 8;

/** Copy `bytes` into a guaranteed `ArrayBuffer`-backed buffer for WebCrypto. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}


export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await subtle.digest("SHA-256", toArrayBuffer(data));
  return new Uint8Array(digest);
}

/** HMAC-SHA256 with the given key (32-byte keys in this suite). */
export async function hmacSha256(
  key: Uint8Array,
  data: Uint8Array,
): Promise<Uint8Array> {
  const cryptoKey = await subtle.importKey(
    "raw",
    toArrayBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await subtle.sign("HMAC", cryptoKey, toArrayBuffer(data));
  return new Uint8Array(mac);
}

export async function hkdf(
  chainingKey: Uint8Array,
  inputKeyMaterial: Uint8Array,
  numOutputs: 2 | 3,
): Promise<Uint8Array[]> {
  const tempKey = await hmacSha256(chainingKey, inputKeyMaterial);
  const output1 = await hmacSha256(tempKey, Uint8Array.of(0x01));
  const output2 = await hmacSha256(
    tempKey,
    concatBytes([output1, Uint8Array.of(0x02)]),
  );
  if (numOutputs === 2) {
    return [output1, output2];
  }
  const output3 = await hmacSha256(
    tempKey,
    concatBytes([output2, Uint8Array.of(0x03)]),
  );
  return [output1, output2, output3];
}


/**
 * Build the 96-bit AES-GCM nonce for counter `n`: 32 bits of zeros followed by the big-endian encoding of `n` (Noise spec §12.3, the AESGCM cipher functions).
 */
export function encodeAesGcmNonce(counter: bigint): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce.set(encodeUint64BE(counter), 4);
  return nonce;
}

/** Import a raw 32-byte key as a non-extractable AES-GCM CryptoKey. */
export async function importAesGcmKey(key: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey(
    "raw",
    toArrayBuffer(key),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

/** AES-256-GCM seal. The 16-byte tag is appended to the ciphertext. */
export async function aesGcmEncrypt(
  key: CryptoKey,
  nonce: Uint8Array,
  associatedData: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const sealed = await subtle.encrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(associatedData),
      tagLength: AES_GCM_TAG_BITS,
    },
    key,
    toArrayBuffer(plaintext),
  );
  return new Uint8Array(sealed);
}

/** AES-256-GCM open. Rejects (throws) on authentication failure. */
export async function aesGcmDecrypt(
  key: CryptoKey,
  nonce: Uint8Array,
  associatedData: Uint8Array,
  ciphertext: Uint8Array,
): Promise<Uint8Array> {
  const opened = await subtle.decrypt(
    {
      name: "AES-GCM",
      iv: toArrayBuffer(nonce),
      additionalData: toArrayBuffer(associatedData),
      tagLength: AES_GCM_TAG_BITS,
    },
    key,
    toArrayBuffer(ciphertext),
  );
  return new Uint8Array(opened);
}


/** Generate a fresh X25519 key pair from the platform CSPRNG. */
export function generateKeyPair(): NoiseKeyPair {
  const keys = x25519.keygen();
  return { privateKey: keys.secretKey, publicKey: keys.publicKey };
}

/** Derive the X25519 public key for a given 32-byte private scalar. */
export function publicKeyFromPrivate(privateKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(privateKey);
}

export function dh(keyPair: NoiseKeyPair, publicKey: Uint8Array): Uint8Array {
  return x25519.getSharedSecret(keyPair.privateKey, publicKey);
}
