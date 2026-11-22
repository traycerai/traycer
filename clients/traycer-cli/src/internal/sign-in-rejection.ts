/**
 * Host refusals that followed a dead sign-in.
 *
 * A host UNAUTHORIZED is refreshed and retried once by the auth-aware
 * messenger. When the refresh itself is rejected the stored sign-in is dead,
 * the host did nothing wrong, and the messenger rethrows the host's original
 * refusal, which carries no trace of that. The call that owns the revalidator
 * marks the refusal here, so a caller that must tell "this CLI is signed out"
 * from "this host will not authenticate this CLI" can.
 */
const refusalsAfterRejectedSignIn = new WeakSet<object>();

export function markRefusalAfterRejectedSignIn(refusal: object): void {
  refusalsAfterRejectedSignIn.add(refusal);
}

export function isRefusalAfterRejectedSignIn(refusal: unknown): boolean {
  return (
    typeof refusal === "object" &&
    refusal !== null &&
    refusalsAfterRejectedSignIn.has(refusal)
  );
}
