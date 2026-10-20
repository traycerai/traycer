/**
 * When each account's usage was last read BY HAND, and whether a retry of it is
 * still withheld.
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
 * Two layers, because they answer different failures:
 *
 * - This module's own map is the FLOOR. It holds in this window whatever
 *   storage does, so a refused write (quota, blocked site data) cannot leave a
 *   settled read unbounded.
 * - `localStorage` is the layer every window of this app SHARES, so the stamp
 *   written by a click in one window is the stamp the next window reads. It
 *   also outlives the strip: hiding and showing the usage region remounts the
 *   cluster, and a bound kept in that component's own state would be reset by
 *   the gesture that re-renders it.
 *
 * A reader takes whichever of the two is later, so neither layer can lift a
 * bound the other still holds.
 *
 * Keyed by HOST as well as account: a read goes to one host, and says nothing
 * about the same account on a different one.
 *
 * Every storage access is wrapped, because storage can be absent or refuse to
 * answer and must never throw into a render.
 */
import { RATE_LIMIT_MANUAL_RETRY_WITHHOLD_MS } from "@/lib/rate-limits/rate-limit-timing";

const MANUAL_RETRY_STAMP_PREFIX = "traycer.rateLimits.manualRead.";

/** This window's floor, by key. */
const stampsHere = new Map<string, number>();

const listeners = new Set<() => void>();

let revision = 0;

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
  stampsHere.set(key, at);
  try {
    window.localStorage.setItem(key, String(at));
  } catch {
    // The floor above already holds this window; other windows keep whatever
    // their own stamps say.
  }
  announce();
}

/**
 * Whether a retry of this account is still withheld at `now`.
 *
 * The one definition of the bound: the segment asks it to decide whether to
 * offer the affordance, and the click asks it again before dispatching,
 * because a rendered offer is only as current as the render that drew it.
 */
export function manualRateLimitRetryWithheld(
  key: string,
  now: number,
): boolean {
  const readAt = manualRateLimitRetryAt(key, now);
  return readAt !== null && now - readAt < RATE_LIMIT_MANUAL_RETRY_WITHHOLD_MS;
}

/**
 * Re-renders a reader when any stamp changes: `storage` for the window that
 * did not write it, and this module's own notification for the one that did,
 * since `storage` never fires in the writing window. Without it a stamp is
 * only seen at the reader's next render, and an offer already on screen would
 * stay clickable until then.
 */
export function subscribeManualRateLimitRetries(
  listener: () => void,
): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener("storage", onStorageChanged);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("storage", onStorageChanged);
    }
  };
}

/** The snapshot `useSyncExternalStore` compares: bumped by every change. */
export function manualRateLimitRetryRevision(): number {
  return revision;
}

/**
 * This account's last hand-driven read, or `null` when nothing valid says.
 *
 * A stamp is invalid when it does not parse as a finite number - it was not
 * written by this code - or when it is more than the withhold AHEAD of `now`,
 * which a wall clock moved backwards leaves behind. Such a stamp reads as
 * absent, and is dropped from storage so a reload cannot find it again. It is
 * not clamped to `now`: a clamp re-dates it on every read, so a stamp from a
 * badly wrong clock would withhold the retry for as long as it sat there.
 */
function manualRateLimitRetryAt(key: string, now: number): number | null {
  const here = valid(stampsHere.get(key) ?? null, now);
  // Dropped once it binds nothing, so the floor holds one entry per account a
  // person actually retried and only while the minute runs. A stamp in STORAGE
  // is left alone unless it is invalid: this window's clock is not the one that
  // wrote it, and a window running ahead must not delete a bound its sibling is
  // still inside.
  if (here === null || now - here >= RATE_LIMIT_MANUAL_RETRY_WITHHOLD_MS) {
    stampsHere.delete(key);
  }
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return here;
  }
  if (raw === null) return here;
  const stored = valid(Number(raw), now);
  if (stored === null) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Unreadable as a stamp either way.
    }
    return here;
  }
  return here === null || stored > here ? stored : here;
}

function valid(at: number | null, now: number): number | null {
  if (at === null || !Number.isFinite(at)) return null;
  return at - now > RATE_LIMIT_MANUAL_RETRY_WITHHOLD_MS ? null : at;
}

function onStorageChanged(event: StorageEvent): void {
  // A `null` key is the whole store clearing, which can drop any stamp.
  if (event.key !== null && !event.key.startsWith(MANUAL_RETRY_STAMP_PREFIX)) {
    return;
  }
  announce();
}

function announce(): void {
  revision += 1;
  for (const listener of listeners) listener();
}
