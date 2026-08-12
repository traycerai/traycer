import { createContext, useContext } from "react";

/**
 * True when the region that RENDERED a portal is concealed — held in a hidden
 * `<Activity>` by a boundary like `HostScopeGate` — so portal surfaces must
 * un-present along with it.
 *
 * React conceals a hidden Activity's in-tree DOM by styling its topmost host
 * nodes, but a portal nested under any host element escapes that: its DOM
 * lives outside the concealed subtree and stays fully visible and interactive
 * (measured — an open settings dialog outlived its panel's concealment).
 * Context crosses portals, so this carries the concealment over the boundary
 * the styling cannot.
 *
 * Consumers un-present the way `usePaneAwareContentGuard` does: return null
 * for the portal CONTENT only, keeping the logical open state and any staged
 * form state in the owning component — both live on fibers inside the
 * concealed (state-preserving) subtree — so the surface re-presents intact
 * when the region returns.
 */
const PortalConcealmentContext = createContext(false);

export const PortalConcealmentProvider = PortalConcealmentContext.Provider;

export function usePortalConcealed(): boolean {
  return useContext(PortalConcealmentContext);
}
