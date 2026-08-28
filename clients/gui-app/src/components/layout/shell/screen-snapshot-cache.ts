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
 * How far either side of the cursor a snapshot is worth keeping.
 *
 * A gesture can only reach the entry before or the entry after, so anything
 * further is a screen no swipe can ask for - and a frozen screen is a whole DOM
 * tree held out of the collector's reach. One step each way is what the feature
 * needs and the ceiling it is allowed.
 */
const RETAINED_NEIGHBOUR_STEPS = 1;

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
 * Files the screen being left under its own entry, then drops everything the
 * cursor's new position puts out of reach.
 *
 * Pruning here rather than on read is what bounds the cache by the SHAPE of
 * history rather than by a count: a long session walks the cursor forward and
 * every screen behind it is released as it goes, while a user stepping back and
 * forth over the same two entries holds exactly the two they can reach.
 */
export function rememberScreenSnapshot(
  leavingIndex: number,
  arrivingIndex: number,
  snapshot: ScreenSnapshot,
): void {
  snapshotsByIndex.set(leavingIndex, snapshot);
  for (const index of snapshotsByIndex.keys()) {
    if (Math.abs(index - arrivingIndex) > RETAINED_NEIGHBOUR_STEPS) {
      snapshotsByIndex.delete(index);
    }
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
