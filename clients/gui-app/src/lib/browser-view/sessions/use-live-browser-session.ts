import { useCallback, useRef, useSyncExternalStore } from "react";
import type { BrowserSessionInfo } from "@traycer/protocol/host/browser/contracts";
import {
  browserSessionAcrossCoordinators,
  subscribeToBrowserSessionsCoordinators,
} from "@/lib/browser-view/sessions/browser-sessions-coordinator";

/**
 * The mention-relevant content key for one session: every tab's `tabId|title|url|status` - exactly the fields the two consumers read (`resolveTabTitle`/`.url` for the composer chip, `.url`/`.status` for annotation staleness).
 */
function liveBrowserSessionContentKey(
  sessionId: string,
  session: BrowserSessionInfo | null,
): string {
  if (session === null) return sessionId;
  const tabs = session.tabs
    .map((tab) => `${tab.tabId}|${tab.title}|${tab.url}|${tab.status}`)
    .join("\x1e");
  return `${sessionId}\x1f${tabs}`;
}

/**
 * Live state for one browser session, resolved across every open coordinator rather than the surrounding `BrowserSessionsContext` - see {@link browserSessionAcrossCoordinators} for why a chip cannot be limited to its tile's host.
 */
export function useLiveBrowserSession(
  sessionId: string,
): BrowserSessionInfo | null {
  const cacheRef = useRef<{
    readonly key: string;
    readonly session: BrowserSessionInfo | null;
  } | null>(null);
  const getSnapshot = useCallback((): BrowserSessionInfo | null => {
    const session = browserSessionAcrossCoordinators(sessionId);
    const key = liveBrowserSessionContentKey(sessionId, session);
    const cached = cacheRef.current;
    if (cached !== null && cached.key === key) return cached.session;
    cacheRef.current = { key, session };
    return session;
  }, [sessionId]);
  return useSyncExternalStore(
    subscribeToBrowserSessionsCoordinators,
    getSnapshot,
    () => null,
  );
}
