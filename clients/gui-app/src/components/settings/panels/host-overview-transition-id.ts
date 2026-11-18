/**
 * A fresh id for ONE logical restart action.
 *
 * `host.restart` is claim-gated: the host grants a shutdown claim keyed by this
 * id, and a request carrying the SAME id adopts the claim it already granted
 * rather than treating its own in-flight restart as competing work. That makes
 * a retry after a lost response idempotent — which matters most over a relay,
 * where the ack can be dropped in the flush window between "accepted" and the
 * host going down.
 *
 * The rule the id enforces cuts both ways, and the second half is why this is a
 * function and not a module constant: a request carrying a DIFFERENT id must
 * never adopt someone else's transition. A shared constant would let this
 * button silently join an update's claim; a fresh id per network attempt would
 * turn the idempotent retry into a busy refusal. So: one id per ARMED action,
 * generated when the user commits to it and reused for every attempt at it.
 *
 * `crypto.randomUUID` is available in every shell this renderer runs in
 * (Electron, modern browsers, and jsdom under Node 19+). The fallback exists
 * only so an exotic host cannot make the restart button throw — uniqueness
 * within one window is all this id needs, since the host scopes claims per
 * process.
 */
export function newTransitionId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi !== undefined && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `restart-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
