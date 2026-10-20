/**
 * When each account's usage was last read BY HAND, in `localStorage`.
 *
 * The strip's `transient` segment offers a retry, and that retry reads with
 * `force: true` - which is what tells the host a person is asking rather than
 * an automatic caller, and so passes the read floors that keep automatic
 * callers off a penalized endpoint. Nothing on the host throttles it after
 * that: its single flight only coalesces reads that overlap, and its probe gate
 * caps how many run at once rather than how often one may be asked for. So the
 * bound on ASKING belongs on this side, and it has to hold wherever the asking
 * happens.
 *
 * `localStorage` is the one layer every window of this app shares, so the
 * stamp written by a click in one window is the stamp the next window reads.
 * It also outlives the strip: hiding and showing the usage region remounts the
 * cluster, and a bound kept in that component's own state would be reset by
 * the gesture that re-renders it.
 *
 * Keyed by HOST as well as account: a read goes to one host, and says nothing
 * about the same account on a different one.
 *
 * Every access is wrapped. Storage can be absent or refuse to answer (private
 * mode, blocked site data), and the bound then degrades to "never read by
 * hand", which costs one extra forced read per window per minute - the same
 * order as the floors every other caller already lives under. It must never
 * throw into a render.
 */

const MANUAL_RETRY_STAMP_PREFIX = "traycer.rateLimits.manualRead.";

/** One account's stamp key, on the host a retry of it would read from. */
export function manualRateLimitRetryKey(
  hostId: string,
  providerId: string,
  profileId: string | null,
): string {
  return `${MANUAL_RETRY_STAMP_PREFIX}${hostId}:${providerId}:${profileId ?? ""}`;
}

/** Records that this account was just read by hand. Call it at SETTLEMENT. */
export function recordManualRateLimitRetry(key: string, at: number): void {
  try {
    window.localStorage.setItem(key, String(at));
  } catch {
    // Unwritable storage leaves the bound to the next window's own stamp.
  }
}

/**
 * When this account was last read by hand, or `null` when nothing says. A
 * stamp that does not parse as a finite number is read as absent rather than
 * trusted: it was not written by this code.
 */
export function manualRateLimitRetryAt(key: string): number | null {
  let stamp: string | null = null;
  try {
    stamp = window.localStorage.getItem(key);
  } catch {
    return null;
  }
  if (stamp === null) return null;
  const at = Number(stamp);
  return Number.isFinite(at) ? at : null;
}
