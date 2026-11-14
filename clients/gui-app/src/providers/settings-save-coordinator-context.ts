import { createContext, useContext } from "react";
import type { SettingsSaveCoordinator } from "@/lib/environment/settings-save-coordinator";

export const SettingsSaveCoordinatorContext =
  createContext<SettingsSaveCoordinator | null>(null);

/** The window's settings-save coordinator; null outside its provider. */
export function useSettingsSaveCoordinator(): SettingsSaveCoordinator | null {
  return useContext(SettingsSaveCoordinatorContext);
}
