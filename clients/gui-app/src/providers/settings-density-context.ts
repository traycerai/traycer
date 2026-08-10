import { createContext, use } from "react";

export type SettingsDensity = "compact" | "relaxed";

/**
 * Whether Settings is rendering inside the height-constrained modal overlay
 * (`compact`) or as a promoted tab / route with the full window height
 * (`relaxed`, the default). The overlay's content frame is hard-capped at
 * `80vh` (`PromotableModalFrame` via `SystemTabModalHost`) while the tab path
 * gets whatever height the window allows, so this is a discrete signal set at
 * the two known entry points - not a continuously measured container size.
 * `relaxed` outside a modal, mirroring `DialogOverlayBoundaryContext`'s
 * "no provider needed outside a dialog" shape.
 */
export const SettingsDensityContext = createContext<SettingsDensity>("relaxed");

export function useSettingsDensity(): SettingsDensity {
  return use(SettingsDensityContext);
}
