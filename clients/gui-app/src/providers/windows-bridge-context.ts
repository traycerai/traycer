import { createContext, use } from "react";
import type { DesktopWindowsBridge } from "@/lib/windows/types";

/** null outside desktop. hasHydrated gates tab-strip skeleton until the first per-window snapshot. */
export interface WindowsBridgeContextValue {
  readonly bridge: DesktopWindowsBridge | null;
  readonly hasHydrated: boolean;
}

const DEFAULT_VALUE: WindowsBridgeContextValue = {
  bridge: null,
  hasHydrated: true,
};

export const WindowsBridgeContext =
  createContext<WindowsBridgeContextValue>(DEFAULT_VALUE);

export function useWindowsBridge(): DesktopWindowsBridge | null {
  return use(WindowsBridgeContext).bridge;
}

export function useWindowsBridgeHydrated(): boolean {
  return use(WindowsBridgeContext).hasHydrated;
}
