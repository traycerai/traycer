import { useSyncExternalStore } from "react";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";
import {
  browserSessionAcrossCoordinators,
  subscribeToBrowserSessionsCoordinators,
} from "@/lib/browser-view/sessions/browser-sessions-coordinator";

/**
 * Live state for one browser session, resolved across every open coordinator
 * rather than the surrounding `BrowserSessionsContext` - see
 * {@link browserSessionAcrossCoordinators} for why a chip cannot be limited to
 * its tile's host. Subscribes to the REGISTRY, so a coordinator appearing
 * later (a tab opened on another host after the chip rendered) resolves it.
 */
export function useLiveBrowserSession(
  sessionId: string,
): BrowserSessionInfo | null {
  return useSyncExternalStore(
    subscribeToBrowserSessionsCoordinators,
    () => browserSessionAcrossCoordinators(sessionId),
    () => null,
  );
}
