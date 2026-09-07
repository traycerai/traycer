/** Suite constants for the Noise_NK_25519_AESGCM_SHA256 implementation. */

/**
 * The Noise protocol name for this suite.
 * It is hashed verbatim into the handshake state (SymmetricState.initialize), so it MUST match the spec's `Noise_<pattern>_<dh>_<cipher>_<hash>` naming exactly.
 */
export const NOISE_PROTOCOL_NAME = "Noise_NK_25519_AESGCM_SHA256";

/** SHA-256 digest length in bytes (HASHLEN). */
export const HASH_LEN = 32;

/** X25519 public-key and DH-output length in bytes (DHLEN). */
export const DH_LEN = 32;

/** AES-256-GCM key length in bytes. */
export const KEY_LEN = 32;

/** AES-GCM authentication tag length in bytes. */
export const TAG_LEN = 16;

/**
 * The reserved maximum nonce value.
 * Both the handshake ciphers and the transport session enforce this ceiling, guaranteeing a (key, nonce) pair is never reused.
 */
export const MAX_NONCE = 2n ** 64n - 1n;

/** Transport-envelope suite version carried in the `v` field of every frame. */
export const NOISE_SUITE_V1 = 1;

/** Transport frame header layout: `[v:1][counter:8 big-endian]`. */
export const TRANSPORT_HEADER_LEN = 9;

/** Default anti-replay sliding-window width, in frames. */
export const DEFAULT_REPLAY_WINDOW_SIZE = 1024;
