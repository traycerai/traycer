import {
  areNestedFocusTargetsEqual,
  type NestedFocusTarget,
} from "@/lib/epic-nested-focus-route";

interface PendingNestedFocusNavigation {
  readonly target: NestedFocusTarget;
  readonly expiresAt: number;
}

const PENDING_NAVIGATION_TTL_MS = 2_000;
const pendingByTab = new Map<string, PendingNestedFocusNavigation>();

function pendingKey(epicId: string, tabId: string): string {
  return `${epicId}\u001f${tabId}`;
}

/**
 * Records the locally prepared target before its async router navigation can
 * commit. Route synchronization must not reapply the old URL target during
 * this short optimistic window or it will bounce focus back to the old pane.
 */
export function beginNestedFocusNavigation(
  epicId: string,
  tabId: string,
  target: NestedFocusTarget,
): void {
  pendingByTab.set(pendingKey(epicId, tabId), {
    target,
    expiresAt: Date.now() + PENDING_NAVIGATION_TTL_MS,
  });
}

/**
 * Returns true only while the route still exposes the stale pre-navigation
 * target. Seeing the pending target means the router caught up and clears the
 * optimistic guard; expiration keeps a failed navigation from becoming sticky.
 */
export function shouldDeferNestedRouteApplication(
  epicId: string,
  tabId: string,
  routeTarget: NestedFocusTarget | null,
): boolean {
  return (
    getNestedRouteApplicationDeferralMs(epicId, tabId, routeTarget) !== null
  );
}

/**
 * Returns the remaining optimistic window so route synchronization can wake
 * itself when a router navigation never commits its target.
 */
export function getNestedRouteApplicationDeferralMs(
  epicId: string,
  tabId: string,
  routeTarget: NestedFocusTarget | null,
): number | null {
  const key = pendingKey(epicId, tabId);
  const pending = pendingByTab.get(key);
  if (pending === undefined) return null;
  const remainingMs = pending.expiresAt - Date.now();
  if (remainingMs <= 0) {
    pendingByTab.delete(key);
    return null;
  }
  if (areNestedFocusTargetsEqual(pending.target, routeTarget)) {
    pendingByTab.delete(key);
    return null;
  }
  return remainingMs;
}

/**
 * When a tab last saw an EXPLICIT nested-focus intent, as a position in one
 * session-wide monotonic sequence.
 *
 * Deliberately a second structure rather than a field on `pendingByTab` above:
 * that map is a 2-second optimistic guard which each read CONSUMES once the
 * router catches up, so it cannot answer a question asked minutes later.
 *
 * It exists for the route's pending artifact focus
 * (`use-epic-route-synchronization`). A cross-task artifact click lands on the
 * task before the artifact's record has projected, so the request waits - and
 * it has to be retired if the person meanwhile does something of their own,
 * instead of opening over whatever they moved to.
 *
 * `navigateNestedFocusWithDomRestore` is the boundary every such gesture
 * crosses: selecting a tile or a pane, closing one, splitting, a blank tab,
 * and an ordinary open. What matters as much is what does NOT cross it -
 * a projection arriving, a Y.Doc hydrating, the persisted layout restoring its
 * tiles, and route-sync's own auto-open, which commits through
 * `replaceNestedFocusRoute` instead. So a stamp taken at that boundary says
 * "the person acted", where any reading of canvas state says only "something
 * changed", and the two are the same thing only until a task finishes loading.
 *
 * ## Why a shared sequence rather than a per-tab count
 *
 * The waiter has to tell an action that happened BEFORE its request from one
 * that happened after, so it samples this when the request is first seen and
 * compares later. The obvious encoding - count per tab, retire on "changed" -
 * has a hole: the per-tab entry is also DROPPED when the sampling surface
 * unmounts, and a dropped entry reads as a change. Under a root
 * `StrictMode` that is fatal, because the replayed mount runs the drop while
 * React RETAINS the sampled baseline: the surface then compares a baseline of
 * 1 against a re-read 0, calls that the person acting, and retires a request
 * nobody touched.
 *
 * Reference-counting the samplers does not help - StrictMode's replay is
 * release-then-reacquire, and the drop lands in the window between them.
 *
 * So the comparison is made ORDERED instead of merely unequal: stamps come
 * from one monotonic sequence shared by every tab, and a request is retired
 * only by a stamp strictly NEWER than its baseline. An absent entry then means
 * "no intent at least as new as your baseline", which is the conservative
 * answer, so dropping one is safe rather than load-bearing. Because the
 * sequence itself is never reset, a genuine intent after a drop still lands
 * above any older baseline, so supersession does not regress through the hole
 * the drop opens.
 *
 * `>` gives up nothing in exchange. Every later mark draws a stamp from the
 * shared sequence, so it is newer than any baseline taken before it - after a
 * drop or an eviction as much as without one. Absence is not a weaker "maybe
 * they acted"; it is the absence of evidence that they did.
 *
 * The sequence is a single integer, so what is unbounded is O(1).
 *
 * The per-tab map is NOT bounded by the mounted samplers, and it would be
 * wrong to claim so: a retained but route-inactive surface can commit a
 * navigation for a tab whose sampler is not mounted, so entries appear with
 * nobody to drop them. {@link forgetExplicitNestedFocusIntents} is therefore
 * promptness, not the bound; the bound is {@link MAX_TRACKED_TABS} below.
 *
 * Per tab, because the question is about the tab the request is landing in: an
 * intent in another task's canvas is not this person turning away from this
 * one.
 */
let explicitIntentSeq = 0;
const lastExplicitIntentSeqByTab = new Map<string, number>();
const explicitIntentListeners = new Set<() => void>();

/**
 * How many tabs' stamps are kept, most recently stamped first.
 *
 * Eviction is safe for the same reason dropping one is: an evicted stamp reads
 * as `0`, which is never newer than a baseline, and the next intent for that
 * tab takes a fresh stamp from the shared sequence - still above any baseline
 * sampled before it. So the cap costs a retirement only for a tab that has sat
 * untouched through this many other tabs' gestures, which is long past the
 * point where a pending request is still waiting on anything.
 */
const MAX_TRACKED_TABS = 128;

/**
 * Watch for any explicit intent. Returns the unsubscribe.
 *
 * Not keyed per tab: a consumer reads its own tab's count in its snapshot, and
 * the surfaces that read one at all are the mounted epic tabs - a handful,
 * each re-reading one number. A per-tab listener registry would be more
 * bookkeeping than the thing it saves.
 *
 * Needed because one gesture this count exists to catch moves nothing else a
 * consumer could subscribe to: re-selecting the tile that is already focused
 * leaves the canvas byte-identical, so without a notification here nothing
 * would re-render to notice the person had acted.
 */
export function subscribeExplicitNestedFocusIntents(
  onChange: () => void,
): () => void {
  explicitIntentListeners.add(onChange);
  return () => explicitIntentListeners.delete(onChange);
}

/**
 * Record an explicit nested-focus intent for this tab.
 *
 * Called at the TOP of the navigation boundary, before the target is prepared
 * and before any of its early returns. Every one of those returns still
 * represents the person having acted: closing the last tile prepares a `null`
 * target, re-selecting the tile already focused prepares an equal one, and a
 * window with no history controller prepares a target it never commits. The
 * gesture happened in all three.
 *
 * Only reached when the caller declared `provenance: "user"`. Whether a commit
 * is a person's is the caller's to state and not this module's to infer - see
 * `NestedFocusProvenance`.
 */
export function markExplicitNestedFocusIntent(
  epicId: string,
  tabId: string,
): void {
  explicitIntentSeq += 1;
  const key = pendingKey(epicId, tabId);
  // Re-inserted, not updated in place, so the map's iteration order is recency
  // and the eviction below drops the tab stamped longest ago.
  lastExplicitIntentSeqByTab.delete(key);
  lastExplicitIntentSeqByTab.set(key, explicitIntentSeq);
  while (lastExplicitIntentSeqByTab.size > MAX_TRACKED_TABS) {
    const oldest = lastExplicitIntentSeqByTab.keys().next();
    if (oldest.done === true) break;
    lastExplicitIntentSeqByTab.delete(oldest.value);
  }
  notifyExplicitIntentListeners();
}

/** Snapshotted, so a listener unsubscribing while being notified cannot
 * mutate the set mid-iteration. */
function notifyExplicitIntentListeners(): void {
  for (const listener of [...explicitIntentListeners]) listener();
}

/**
 * Where this tab's most recent explicit intent sits in the sequence, to sample
 * as a baseline and compare a later sample against with `>`.
 *
 * `0` - no intent recorded for this tab, either because none happened or
 * because {@link forgetExplicitNestedFocusIntents} dropped it - is below every
 * stamp the sequence can issue, so it never reads as newer than a baseline.
 */
export function lastExplicitNestedFocusIntentSeq(
  epicId: string,
  tabId: string,
): number {
  return lastExplicitIntentSeqByTab.get(pendingKey(epicId, tabId)) ?? 0;
}

/**
 * Drop a tab's stamp when its sampling surface goes, so a stamp is released
 * promptly rather than waiting for {@link MAX_TRACKED_TABS} to evict it.
 *
 * Safe to call at any moment, including while a surface still holds a baseline
 * sampled from the stamp being dropped - which a root `StrictMode` replay does
 * on every mount. A dropped stamp reads as `0`, and `0` is never newer than a
 * baseline, so the drop cannot retire a request; the next intent takes a fresh
 * stamp from the shared sequence, which is still above that baseline.
 *
 * Notifies when it actually removed one, because that is a `getSnapshot`
 * change and an external store owes its subscribers the news. The handful of
 * mounted readers each re-read one number and re-render only if it moved.
 */
export function forgetExplicitNestedFocusIntents(
  epicId: string,
  tabId: string,
): void {
  if (!lastExplicitIntentSeqByTab.delete(pendingKey(epicId, tabId))) return;
  notifyExplicitIntentListeners();
}

export function resetNestedFocusNavigationIntentsForTests(): void {
  pendingByTab.clear();
  lastExplicitIntentSeqByTab.clear();
  explicitIntentSeq = 0;
}
