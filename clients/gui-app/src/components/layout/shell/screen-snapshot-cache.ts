import type { ScreenSnapshot } from "@/components/layout/shell/screen-snapshot";

/**
 * The frozen screens a swipe can move, keyed by the history entry each one
 * shows.
 *
 * A back gesture needs the destination visible from its FIRST pixel, before
 * anything has been navigated - so the destination cannot be produced on
 * demand. It does not have to be: every screen a back swipe can reach is one
 * the user has already been on, so the copy is taken on the way OUT, at the
 * moment the app leaves a screen, and is waiting by the time a swipe asks for
 * it.
 *
 * Keyed by the entry's stable KEY (`__TSR_key`) rather than by its index,
 * because an index is a POSITION and positions move under a live cache: the
 * prune scheduler re-stamps `__TSR_index` contiguously after dropping dead
 * entries, and a push after a back reuses the truncated position for a new
 * entry. A screen filed under an index can silently start naming a different
 * entry after either; a screen filed under the entry's own key cannot - the
 * key survives re-stamping and is never reused.
 */

/**
 * How many frozen screens are worth holding at once.
 *
 * Retention is by RECENCY rather than by distance from the current entry,
 * because the cursor moves: a single gesture can only reach the entry either
 * side of it, but the next gesture starts from where that one landed, and a
 * run of consecutive back swipes walks the cursor across screens that were all
 * two-or-more steps away when they were filed. Pruning against the arrival
 * index released exactly those screens, so the second back of a run had
 * nothing to move and fell back to instant navigation.
 *
 * The count bounds what a distance rule bounded before - a frozen screen is a
 * whole DOM tree held out of the collector's reach - and it is sized to cover
 * a run of swipes rather than a whole session: deep enough that consecutive
 * steps keep animating, small enough that a long walk releases the screens it
 * has left behind.
 */
const MAX_RETAINED_SCREENS = 4;

const snapshotsByEntryKey = new Map<string, ScreenSnapshot>();

/**
 * The stable key of the entry a location names, or `null` when the router has
 * not stamped one - a document the app did not navigate to, which no screen
 * can be reliably filed against.
 *
 * Read defensively rather than through a declared shape. `HistoryState` is an
 * augmentable interface that promises nothing about `__TSR_key`; the router
 * stamps it, but a session restored into an entry someone else pushed carries
 * whatever that writer put there. A missing or non-string key is a screen
 * with no usable identity, which is exactly the answer this returns.
 */
export function readHistoryEntryKey(location: {
  readonly state: unknown;
}): string | null {
  const state: unknown = location.state;
  if (typeof state !== "object" || state === null) return null;
  if (!("__TSR_key" in state)) return null;
  const key: unknown = state.__TSR_key;
  return typeof key === "string" ? key : null;
}

/**
 * Files the screen being left under its own entry, releasing the
 * least-recently-filed screen once the cache is full.
 *
 * Re-filing an entry replaces its screen AND refreshes its recency - the entry
 * was just departed, which is the strongest claim on being swiped back to.
 */
export function rememberScreenSnapshot(
  leavingKey: string,
  snapshot: ScreenSnapshot,
): void {
  snapshotsByEntryKey.delete(leavingKey);
  snapshotsByEntryKey.set(leavingKey, snapshot);
  for (const key of snapshotsByEntryKey.keys()) {
    if (snapshotsByEntryKey.size <= MAX_RETAINED_SCREENS) break;
    snapshotsByEntryKey.delete(key);
  }
}

/**
 * The frozen screen for an entry, or `null` when there is none - a cold start,
 * a restored session, or the first step of a run. A swipe with no destination
 * to show does not invent one: it falls back to the instant navigation this
 * gesture performed before the transition existed.
 */
export function readScreenSnapshot(entryKey: string): ScreenSnapshot | null {
  return snapshotsByEntryKey.get(entryKey) ?? null;
}

/** Releases every held screen. For teardown and for tests. */
export function clearScreenSnapshots(): void {
  snapshotsByEntryKey.clear();
}
