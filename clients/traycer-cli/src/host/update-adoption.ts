import {
  consumeUpdateAttemptAdoption,
  resolveAttemptAdoptionFromNonce,
  UPDATE_ADOPTION_MAX_AGE_MS,
  type ConsumedUpdateAdoption,
} from "@traycer-clients/shared/host-update";

// CLI view of update-attempt adoption. Do not continue an attempt this CLI did not adopt.

export type { ConsumedUpdateAdoption };
export { UPDATE_ADOPTION_MAX_AGE_MS };

/** Read and consume the proof named by `nonce`. Total: missing, unreadable, malformed, expired, or naming a different host home all resolve to `absent`, and every `absent` makes the caller fall back to ordinary lock acquisition. */
export { consumeUpdateAttemptAdoption };

/** Resolve a `--attempt-adoption <nonce>` flag into a proof, or `undefined`. `undefined` is the ordinary case and the safe one. */
export { resolveAttemptAdoptionFromNonce };
