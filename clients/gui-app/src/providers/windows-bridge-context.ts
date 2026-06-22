import { createContext, use } from "react";
import type { DesktopWindowsBridge } from "@/lib/windows/types";

/**
 * Combined value: the resolved bridge (or `null` outside desktop) plus a
 * `hasHydrated` flag that flips true once the per-window snapshot has
 * been applied at least once. Children render immediately; surfaces that
 * need post-hydration state (notably the tab strip) read `hasHydrated`
 * to gate skeleton rendering.
 */
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
