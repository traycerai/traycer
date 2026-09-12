/**
 * Which edge reported that a host became available again, and so how much of
 * what the client cached for that host a recovery sweep re-asks.
 *
 * - `"reconnect"`: a session opened again after it dropped, or a remote
 *   session reached a ready boundary. The host may have restarted while the
 *   connection was down, so a read that already settled may describe a
 *   process that is gone.
 * - `"stall"`: the socket survived. The host answered a ping late (its event
 *   loop stalled), or answered a wake probe after the device slept. The same
 *   process is on the other end, so what it already answered still stands,
 *   and only the reads that failed during the gap are stranded.
 *
 * Neither kind re-issues a read whose current attempt is still in flight and
 * has not failed. That rule, and what each kind re-asks, live in gui-app's
 * `createHostQueryInvalidator`.
 */
export type AvailabilityRecoveryKind = "reconnect" | "stall";

/**
 * The kind two merged reports sweep as. A reconnect sweep re-asks everything a
 * stall sweep does and more, so it wins whenever the two meet. `held` is
 * `null` while nothing is held yet.
 */
export function mergeAvailabilityRecoveryKinds(
  held: AvailabilityRecoveryKind | null,
  next: AvailabilityRecoveryKind,
): AvailabilityRecoveryKind {
  return held === "reconnect" ? held : next;
}
