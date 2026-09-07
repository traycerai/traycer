import { useRouter } from "@tanstack/react-router";
import type { RouterHistory } from "@tanstack/react-router";
import { getHistoryController } from "@/lib/persistent-history";
import { isMobileApp } from "@/lib/mobile-app";

/**
 * Whether in-app back/forward may show CHROME on this shell - the header arrows, the mouse-button reservation, the palette rows.
 */
export function historyNavChromeAvailable(history: RouterHistory): boolean {
  if (getHistoryController(history) === null) return false;
  return !isMobileApp();
}

/**
 * {@link historyNavChromeAvailable} for a component, off the CURRENT router's history - never a module-level singleton, so multi-window routers each resolve their own.
 */
export function useHistoryNavAvailable(): boolean {
  const router = useRouter();
  return historyNavChromeAvailable(router.history);
}
