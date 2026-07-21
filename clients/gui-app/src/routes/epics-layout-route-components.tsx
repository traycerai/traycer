import { Outlet } from "@tanstack/react-router";

/**
 * Route adapter for `/epics`. Signed-in bodies are mounted by
 * `TopLevelTabHost`; the outlet remains only for deep-link fallbacks.
 */
export function EpicsLayoutRoute() {
  return <Outlet />;
}
