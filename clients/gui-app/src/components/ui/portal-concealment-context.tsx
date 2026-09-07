import { createContext, useContext } from "react";

/** Context crosses portals, so this carries the concealment over the boundary the styling cannot. */
const PortalConcealmentContext = createContext(false);

export const PortalConcealmentProvider = PortalConcealmentContext.Provider;

export function usePortalConcealed(): boolean {
  return useContext(PortalConcealmentContext);
}
