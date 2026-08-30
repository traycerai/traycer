import {
  consumeUpdateAttemptAdoption,
  resolveAttemptAdoptionFromNonce,
  UPDATE_ADOPTION_MAX_AGE_MS,
  type ConsumedUpdateAdoption,
} from "@traycer-clients/shared/host-update";

// The CLI's view of the update-attempt adoption transport (Ticket 05, Ruling 1).
//
// ## Consume only — and that is enforced, not merely intended
//
// The implementation is shared (`shared/host-update/adoption-transport.ts`)
// because the two halves have different owners: Desktop MINTS, as the
// packaged-macOS executor that holds the attempt lock and spawns bundled-CLI
// children inside its own segment; the CLI CONSUMES, as those children,
// validating the parent's live proof instead of contending for a lock the
// parent already holds.
//
// This adapter therefore re-exports the consume half and **nothing else**. The
// mint side is deliberately absent: there is no `writeAdoptionProof` here, and
// an architecture check asserts that name never appears in this file's export
// surface. Without that check the property could be revived silently — adding
// the mint to this adapter would make every downstream CLI file import it from
// here rather than from shared, and an importer-side assertion may not see
// through that hop.
//
// The CLI never mints because it never holds a segment whose children need a
// proof. If that ever changes — a first-class CLI claimant delegating to its own
// child process — it is a deliberate gate extension with review, never an
// addition to this adapter's exports.

export type { ConsumedUpdateAdoption };
export { UPDATE_ADOPTION_MAX_AGE_MS };

/**
 * Read and consume the proof named by `nonce`.
 *
 * Total: missing, unreadable, malformed, expired, or naming a different host
 * home all resolve to `absent`, and every `absent` makes the caller fall back to
 * ordinary lock acquisition. That fallback is what keeps a solo invocation of
 * every adoption-aware command byte-identical to its behaviour before adoption
 * existed.
 */
export { consumeUpdateAttemptAdoption };

/**
 * Resolve a `--attempt-adoption <nonce>` flag into a proof, or `undefined`.
 *
 * `undefined` is the ordinary case and the safe one. It deliberately does not
 * fail the command when a proof is unusable: a child spawned with a stale nonce
 * is not a security event, it simply contends for the lock like any other
 * caller and either wins it or reports the same busy refusal it always would.
 */
export { resolveAttemptAdoptionFromNonce };
