import { createContext, useContext } from "react";
import type { SimulatorCatalogModel } from "@/hooks/simulator/use-simulator-catalog-inventory";

/**
 * One task simulator catalog query, shared by the rail's presence rule, the
 * Mobile simulators panel, the mobile switcher and the tiles.
 */
export const SimulatorCatalogContext =
  createContext<SimulatorCatalogModel | null>(null);

export function useSimulatorCatalogContext(): SimulatorCatalogModel | null {
  return useContext(SimulatorCatalogContext);
}
