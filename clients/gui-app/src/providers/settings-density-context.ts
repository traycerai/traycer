import { createContext, use } from "react";

export type SettingsDensity = "compact" | "relaxed";

/** compact is the 80vh modal overlay; relaxed is the tab/route default. Discrete entry-point signal, not measured container size. */
export const SettingsDensityContext = createContext<SettingsDensity>("relaxed");

export function useSettingsDensity(): SettingsDensity {
  return use(SettingsDensityContext);
}
