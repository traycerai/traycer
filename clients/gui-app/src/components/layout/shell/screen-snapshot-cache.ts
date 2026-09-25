import {
  releaseScreenSnapshot,
  type ScreenSnapshot,
} from "@/components/layout/shell/screen-snapshot";
import { getRetentionProfile } from "@/stores/replica-memory/retention-profile";

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
 * How many frozen screens are worth holding at once - the active retention
 * profile's number, read on every filing so the phone runs its own without a
 * platform branch here.
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
 * whole DOM tree held out of the collector's reach, canvas pixels included.
 *
 * WHY THE PHONE HOLDS ONE. A depth of N animates a run of N - 1 steps, not N:
 * every commit files the screen it has just left - the drag's own outgoing
 * copy, handed straight back here by `use-swipe-nav-transition` - so one slot
 * is always spent on the step the user just took. Two is therefore worth
 * exactly what one is; both animate the first back of a run and miss on the
 * second. One is the smallest number that still animates what the phone
 * actually does:
 *
 *  - the immediate back, whose destination is the entry the app left LAST and
 *    so is the newest thing here;
 *  - the forward that undoes it, whose destination is the screen that same
 *    commit filed on its way out;
 *  - and an oscillation between the two, indefinitely, because every step
 *    files exactly the screen the next one asks for.
 *
 * What it gives up is the second and later step of a run in ONE direction, and
 * giving that up is not a failure: {@link readScreenSnapshot} answers `null`
 * and the gesture performs the instant navigation it did before this
 * transition existed. Three spare screens of held DOM is the wrong price for
 * animating a swipe run on a process iOS kills at 2 GB.
 */
function maxRetainedScreens(): number {
  return getRetentionProfile().retainedScreenSnapshots;
}

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
  const cap = maxRetainedScreens();
  for (const key of snapshotsByEntryKey.keys()) {
    if (snapshotsByEntryKey.size <= cap) break;
    // Dropped, never destroyed. An evicted screen can still be ON SCREEN: a
    // committed settle is carrying the destination it read from here while
    // this very call files the outgoing copy over it, and at a cap of one that
    // filing is what evicts it. Releasing its canvases would blank a terminal
    // tile mid-transition. Unreferenced is enough - the collector owns the
    // rest, and {@link clearScreenSnapshots} is where waiting for it is not.
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

/**
 * Releases every held screen, and DESTROYS them rather than only letting go.
 *
 * Both callers are moments where letting go is not enough. The hook unmounting
 * is the cheap one; the app going off screen is the one that matters, because
 * a backgrounded iOS app is measured - and killed - while it is suspended and
 * no collection runs at all. So the pixel buffers go now
 * ({@link releaseScreenSnapshot}) instead of whenever the collector next gets
 * a turn.
 *
 * Destroying is safe HERE and not on eviction, because the caller takes the
 * transition's layers down before clearing: nothing held here is on screen by
 * the time this runs. See the note in {@link rememberScreenSnapshot} for the
 * eviction side.
 */
export function clearScreenSnapshots(): void {
  for (const snapshot of snapshotsByEntryKey.values()) {
    releaseScreenSnapshot(snapshot);
  }
  snapshotsByEntryKey.clear();
}
