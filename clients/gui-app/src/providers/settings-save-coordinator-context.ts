import { createContext, useContext } from "react";
import type { SettingsSaveCoordinator } from "@/lib/environment/settings-save-coordinator";

export const SettingsSaveCoordinatorContext =
  createContext<SettingsSaveCoordinator | null>(null);

export function useSettingsSaveCoordinator(): SettingsSaveCoordinator | null {
  return useContext(SettingsSaveCoordinatorContext);
}
