/**
 * What this app has already asked for, per account: when a person last read
 * one BY HAND, and whether the one re-read a transient episode promises has
 * been taken.
 *
 * Both answer the same question from different sides - may this account be
 * asked for again - so they are keyed identically, by host as well as account:
 * a read goes to one host, and says nothing about the same account on a
 * different one.
 *
 * ## The hand-driven bound
 *
 * The strip's `transient` segment offers a retry, and that retry reads with
 * `force: true` - which is what tells the host a person is asking rather than
 * an automatic caller, and so passes the read floors that keep automatic
 * callers off a penalized endpoint. Nothing on the host throttles it after
 * that: its single flight only coalesces reads that overlap, and its probe gate
 * caps how many run at once rather than how often one may be asked for. So the
 * bound on ASKING belongs on this side, and it has to hold wherever the asking
 * happens. Two layers, because they answer different failures:
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
 * bound the other still holds. Every storage access is wrapped, because
 * storage can be absent or refuse to answer and must never throw into a
 * render.
 *
 * ## The episode one-shot
 *
 * The transient words promise a retry, so the strip schedules exactly one,
 * `TRANSIENT_RATE_LIMIT_RETRY_DELAY_MS` after the account entered the state;
 * the 15-minute poll owns the cadence from there. One per EPISODE, not one per
 * mount: the run of failures is a single episode, and it ends when the account
 * is answered - a reading, or an authoritative reason. Kept here rather than
 * in the component that times it, because that component unmounts for reasons
 * that are not the end of an episode - hiding the usage region, a re-render of
 * the strip - and a one-shot it re-armed each time would be a read a minute
 * for as long as the account kept failing.
 *
 * The episode is NAMED by the envelope's `episode`, an identity minted by the
 * last answer about that account, which every failure in one run carries and
 * no two runs share. So an entry records which episode spent the read, and the
 * question "is one owed" is answered by comparing, with nothing to release:
 * the answer that ends an episode often lands where no strip is drawing the
 * account - a background poll, a read from a different surface, a window that
 * was hidden - and anything that had to observe it being drawn would miss it.
 *
 * In memory only, deliberately: this is a record of a read THIS renderer owes
 * and has taken. A sibling window has its own cache and its own poll, and
 * suppressing its first re-read because this one already made it would leave
 * it drawing words it never acted on. What bounds the provider traffic that
 * follows is the host's own floors, per lane (see the PR body's numbers).
 *
 * Two things bound the map, because they answer different questions. An
 * account the strip's host NO LONGER HAS is pruned, from that host's own
 * account inventory - never from what is on screen, since hiding a provider,
 * picking a different profile and remounting the strip all leave a run of
 * failures exactly where it was. And the map carries a hard cap with
 * oldest-first eviction, which is what bounds the hosts this window is not
 * pointed at: the renderer cannot enumerate another host's accounts, and
 * dropping a host's entries when the strip leaves it would re-arm a read that
 * run of failures has already had. An eviction costs at most one extra
 * unforced read for that account, which the host's floor bounds.
 */
import { RATE_LIMIT_MANUAL_RETRY_WITHHOLD_MS } from "@/lib/rate-limits/rate-limit-timing";

/**
 * The storage prefix, and so what the `storage` filter below matches. Its
 * value is what windows already carry, so it stays as it is.
 */
const LEDGER_KEY_PREFIX = "traycer.rateLimits.manualRead.";

/** This window's floor for the hand-driven bound, by key. */
const stampsHere = new Map<string, number>();

/** By account: the episode whose one scheduled read has been spent. */
const spentEpisodes = new Map<string, number>();

/**
 * How many of those entries this window keeps. One entry is an account on a
 * host, so the live number is the accounts a person has across the hosts this
 * window has pointed at; this is two orders of magnitude above that, and it is
 * here so a session that keeps meeting fresh accounts cannot grow the map
 * without limit.
 */
const MAX_SPENT_EPISODES = 256;

const listeners = new Set<() => void>();

let revision = 0;

/** One account's ledger key, on the host a read of it would go to. */
export function rateLimitAccountLedgerKey(
  hostId: string,
  providerId: string,
  profileId: string | null,
): string {
  return `${LEDGER_KEY_PREFIX}${hostId}:${providerId}:${profileId ?? ""}`;
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
 * Whether this account is still owed the one scheduled re-read of `episode`,
 * the identity of the run of failures it is in (`NO_EPISODE` for a key with no
 * envelope).
 *
 * A spent entry from any OTHER episode is not this episode's, so an account
 * answered and failing again owes one without anything having released it.
 */
export function scheduledTransientReadOwed(
  key: string,
  episode: number,
): boolean {
  return spentEpisodes.get(key) !== episode;
}

/**
 * The scheduled re-read of this episode has been taken. Recorded when the
 * timer fires, whether or not a request went out: a read already in flight IS
 * the retry the words promise, and asking again over it is what the skip
 * avoids.
 */
export function recordScheduledTransientRead(
  key: string,
  episode: number,
): void {
  // Re-inserted, so an entry this window keeps touching is not the oldest one:
  // a `Map` iterates in insertion order, and a plain `set` on an existing key
  // keeps its original place.
  spentEpisodes.delete(key);
  spentEpisodes.set(key, episode);
  while (spentEpisodes.size > MAX_SPENT_EPISODES) {
    const oldest = spentEpisodes.keys().next();
    if (oldest.done === true) return;
    spentEpisodes.delete(oldest.value);
  }
}

/**
 * Forgets this host's entries for accounts the host no longer HAS - a profile
 * deleted, a provider signed out of entirely.
 *
 * `exists` is that host's own account inventory, and nothing about what is
 * drawn: a hidden provider, an unpicked profile and an unmounted strip are all
 * still the same run of failures, and the three rounds before this one each
 * lost a live entry to one of them. Whether the caller KNOWS what exists is
 * the caller's question - the hook holds an unanswered provider list back
 * rather than reporting it as an empty inventory.
 */
export function pruneScheduledTransientReads(
  hostId: string,
  exists: ReadonlySet<string>,
): void {
  const prefix = `${LEDGER_KEY_PREFIX}${hostId}:`;
  for (const key of spentEpisodes.keys()) {
    if (key.startsWith(prefix) && !exists.has(key)) spentEpisodes.delete(key);
  }
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
  if (event.key !== null && !event.key.startsWith(LEDGER_KEY_PREFIX)) {
    return;
  }
  announce();
}

function announce(): void {
  revision += 1;
  for (const listener of listeners) listener();
}
