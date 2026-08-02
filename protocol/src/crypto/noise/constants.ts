/**
 * Suite constants for the Noise_NK_25519_AESGCM_SHA256 implementation.
 *
 * These are the only place the wire-level magic numbers live, so a security
 * reviewer can check the suite parameters against the Noise spec in one glance.
 */

/**
 * The Noise protocol name for this suite. It is hashed verbatim into the
 * handshake state (SymmetricState.initialize), so it MUST match the spec's
 * `Noise_<pattern>_<dh>_<cipher>_<hash>` naming exactly.
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
 * The reserved maximum nonce value. Per the Noise spec a CipherState nonce must
 * never reach 2^64 - 1 for an application message; reaching it forces a rekey
 * (or session termination). Both the handshake ciphers and the transport
 * session enforce this ceiling, guaranteeing a (key, nonce) pair is never
 * reused.
 */
export const MAX_NONCE = 2n ** 64n - 1n;

/**
 * Transport-envelope suite version carried in the `v` field of every frame.
 * `v === 1` denotes Noise_NK_25519_AESGCM_SHA256. Bumping the suite (new DH,
 * cipher, or hash) allocates a new value here without ambiguity on the wire.
 */
export const NOISE_SUITE_V1 = 1;

/**
 * Transport frame header layout: `[v:1][counter:8 big-endian]`.
 * The header is authenticated as AEAD associated data, so neither the version
 * nor the counter can be tampered with without failing decryption.
 */
export const TRANSPORT_HEADER_LEN = 9;

/**
 * Default anti-replay sliding-window width, in frames. The relay/mux may
 * reorder or duplicate frames, so the receiver accepts any counter newer than
 * the window and any unseen counter within it, and rejects everything older.
 */
export const DEFAULT_REPLAY_WINDOW_SIZE = 1024;
