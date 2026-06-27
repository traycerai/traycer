import { useRouter } from "@tanstack/react-router";
import { getHistoryController } from "@/lib/persistent-history";

/**
 * The single feature-availability signal for in-app back/forward navigation:
 * `true` when the CURRENT router's history carries the persistent-history
 * controller brand (the Electron renderer), `false` under browser/memory
 * history (the web app).
 *
 * Every input surface — header arrows, mouse listener, keybind reservation,
 * palette emission — reads this same flag so the feature is wholly inert
 * outside Electron (tech plan §3.6). Reads `useRouter().history`, never a
 * module-level singleton, so multi-window routers each resolve their own
 * history.
 */
export function useHistoryNavAvailable(): boolean {
  const router = useRouter();
  return getHistoryController(router.history) !== null;
}
