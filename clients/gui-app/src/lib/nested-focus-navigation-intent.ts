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
 * How many EXPLICIT nested-focus intents a tab has seen this session.
 *
 * Deliberately a second structure rather than a field on `pendingByTab` above:
 * that map is a 2-second optimistic guard which each read CONSUMES once the
 * router catches up, so it cannot answer a question asked minutes later. This
 * one is monotonic and is never consumed.
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
 * `replaceNestedFocusRoute` instead. So a count taken at that boundary says
 * "the person acted", where any reading of canvas state says only "something
 * changed", and the two are the same thing only until a task finishes loading.
 *
 * A COUNT, not a flag, because the waiter has to tell an action that happened
 * BEFORE its request from one that happened after: a tab the person had
 * already been working in would otherwise retire every request made into it.
 * The value means nothing on its own - only a change between two samples of it
 * does - so it is sampled when the request is first seen and compared later.
 *
 * Per tab, because the question is about the tab the request is landing in: an
 * intent in another task's canvas is not this person turning away from this
 * one.
 */
const explicitIntentRevisionByTab = new Map<string, number>();
const explicitIntentListeners = new Set<() => void>();

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
 */
export function markExplicitNestedFocusIntent(
  epicId: string,
  tabId: string,
): void {
  const key = pendingKey(epicId, tabId);
  explicitIntentRevisionByTab.set(
    key,
    (explicitIntentRevisionByTab.get(key) ?? 0) + 1,
  );
  // Snapshotted, so a listener unsubscribing while being notified cannot
  // mutate the set mid-iteration.
  for (const listener of [...explicitIntentListeners]) listener();
}

/** The tab's current intent count, to sample and compare against later. */
export function explicitNestedFocusIntentRevision(
  epicId: string,
  tabId: string,
): number {
  return explicitIntentRevisionByTab.get(pendingKey(epicId, tabId)) ?? 0;
}

/**
 * Drop a tab's count. Called when the surface that samples it goes away, so
 * the map stays bounded by the tabs currently mounted rather than growing with
 * every tab ever opened. Dropping it is safe because a baseline is only ever
 * compared against a sample taken after it: a remounted surface takes a fresh
 * one.
 */
export function retireExplicitNestedFocusIntents(
  epicId: string,
  tabId: string,
): void {
  explicitIntentRevisionByTab.delete(pendingKey(epicId, tabId));
}

export function resetNestedFocusNavigationIntentsForTests(): void {
  pendingByTab.clear();
  explicitIntentRevisionByTab.clear();
}
