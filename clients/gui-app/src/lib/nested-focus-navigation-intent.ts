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
  const key = pendingKey(epicId, tabId);
  const pending = pendingByTab.get(key);
  if (pending === undefined) return false;
  if (Date.now() > pending.expiresAt) {
    pendingByTab.delete(key);
    return false;
  }
  if (areNestedFocusTargetsEqual(pending.target, routeTarget)) {
    pendingByTab.delete(key);
    return false;
  }
  return true;
}

export function resetNestedFocusNavigationIntentsForTests(): void {
  pendingByTab.clear();
}
