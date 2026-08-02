/**
 * Typed errors for the Noise layer. Each failure mode is its own class so
 * callers (the host responder and client initiator) can branch on cause —
 * e.g. a replayed frame is operationally different from a corrupt one — and so
 * a security reviewer can see every distinct failure exit.
 */

export class NoiseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoiseError";
  }
}

/** A handshake message was malformed, out of order, or structurally invalid. */
export class NoiseHandshakeError extends NoiseError {
  constructor(message: string) {
    super(message);
    this.name = "NoiseHandshakeError";
  }
}

/** AEAD authentication failed (tampered ciphertext, wrong key, or bad AD). */
export class NoiseDecryptError extends NoiseError {
  constructor(message: string) {
    super(message);
    this.name = "NoiseDecryptError";
  }
}

/** The nonce counter reached its ceiling; a rekey (or new session) is required. */
export class NoiseNonceError extends NoiseError {
  constructor(message: string) {
    super(message);
    this.name = "NoiseNonceError";
  }
}

/** A transport frame carried a replayed or too-old counter. */
export class NoiseReplayError extends NoiseError {
  constructor(message: string) {
    super(message);
    this.name = "NoiseReplayError";
  }
}

/** An operation was attempted in the wrong state (e.g. before the handshake). */
export class NoiseStateError extends NoiseError {
  constructor(message: string) {
    super(message);
    this.name = "NoiseStateError";
  }
}
