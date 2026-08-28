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
 * Keyed by the router's own `__TSR_index` rather than by href, because the
 * index is what a step actually moves along: two entries can share an href, and
 * a back from the second must land on the first rather than on itself.
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

const snapshotsByIndex = new Map<number, ScreenSnapshot>();

/**
 * The history entry a location names, or `null` when the router has not stamped
 * one - a document the app did not navigate to, which has no neighbours worth
 * remembering.
 *
 * Read defensively rather than through a declared shape. `HistoryState` is an
 * augmentable interface that promises nothing about `__TSR_index`; the router
 * stamps it, but a session restored into an entry someone else pushed carries
 * whatever that writer put there. A missing or non-numeric index is a screen
 * with no knowable neighbours, which is exactly the answer this returns.
 */
export function readHistoryIndex(location: {
  readonly state: unknown;
}): number | null {
  const state: unknown = location.state;
  if (typeof state !== "object" || state === null) return null;
  if (!("__TSR_index" in state)) return null;
  const index: unknown = state.__TSR_index;
  return typeof index === "number" ? index : null;
}

/**
 * Files the screen being left under its own entry, releasing the
 * least-recently-filed screen once the cache is full.
 *
 * Re-filing an entry replaces its screen AND refreshes its recency - the entry
 * was just departed, which is the strongest claim on being swiped back to.
 * Every departure files the departed entry, so an index reused by a later push
 * is always overwritten before it can be a swipe's destination again.
 */
export function rememberScreenSnapshot(
  leavingIndex: number,
  snapshot: ScreenSnapshot,
): void {
  snapshotsByIndex.delete(leavingIndex);
  snapshotsByIndex.set(leavingIndex, snapshot);
  for (const index of snapshotsByIndex.keys()) {
    if (snapshotsByIndex.size <= MAX_RETAINED_SCREENS) break;
    snapshotsByIndex.delete(index);
  }
}

/**
 * The frozen screen for an entry, or `null` when there is none - a cold start,
 * a restored session, or the first step of a run. A swipe with no destination
 * to show does not invent one: it falls back to the instant navigation this
 * gesture performed before the transition existed.
 */
export function readScreenSnapshot(index: number): ScreenSnapshot | null {
  return snapshotsByIndex.get(index) ?? null;
}

/** Releases every held screen. For teardown and for tests. */
export function clearScreenSnapshots(): void {
  snapshotsByIndex.clear();
}
