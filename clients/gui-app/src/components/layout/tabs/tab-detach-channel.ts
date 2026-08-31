/**
 * The channel between `RootDndProvider` (which ends the tear-off drag) and the
 * route-tree component that owns the "open in new window" flow.
 *
 * WHY THIS EXISTS AT ALL. The detach flow reaches `useRouterState`, which
 * THROWS when there is no router, where `useNavigate` merely warns. Calling it
 * from `RootDndProvider` made that provider router-REQUIRED - a change of kind
 * from router-optional, made silently, that broke four tests and survived two
 * certifications before anyone noticed. Moving the hook into a component that
 * lives in the ROUTE TREE makes the requirement structural: a route component
 * renders under `<Outlet />` and so cannot exist without a router, which means
 * the dependency is satisfied by placement rather than by a runtime check.
 * A placement fact cannot be dormant; a runtime guard can.
 *
 * WHY `null` IS NOT `{ isAvailable: false }`. The two states mean different
 * things and collapsing them would hide a production failure:
 *
 *   null                              nobody is listening - the owner never
 *                                     mounted. Under a router this is a DEFECT.
 *   { isAvailable: false }            the owner is listening and says no
 *                                     (no desktop bridge, or the epic flow is
 *                                     unavailable). Entirely normal.
 *
 * Collapsed into one boolean, a child that silently stopped mounting would make
 * every tear-off fall through to ordinary drop handling: the user drags a tab
 * off the strip and it reorders instead, with no crash and no warning. That is
 * strictly worse than the throw this replaces, because the throw was loud.
 */
import type { HeaderTab } from "@/stores/tabs/types";

export interface TabDetachHandler {
  /**
   * Whether a detach can actually be performed right now. Distinct from the
   * handler's existence: this is the owner's answer, not the question of
   * whether an owner exists.
   */
  readonly isAvailable: boolean;
  readonly requestOpen: (tab: HeaderTab) => void;
}

let handler: TabDetachHandler | null = null;

/**
 * Publish the handler. Called by the route-tree owner on mount and whenever the
 * flow identity changes; returns the unsubscribe so the owner can withdraw it.
 */
export function publishTabDetachHandler(next: TabDetachHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/**
 * `null` means no owner is mounted - NOT that detach is unavailable. Callers
 * must distinguish the two; see the module comment.
 */
export function readTabDetachHandler(): TabDetachHandler | null {
  return handler;
}

/** Test seam: drop any published handler between cases. */
export function resetTabDetachHandler(): void {
  handler = null;
}
