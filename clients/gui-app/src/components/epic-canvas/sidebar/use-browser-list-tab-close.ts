import { useCallback } from "react";
import { useBrowserCatalogActions } from "@/hooks/browser/use-browser-catalog-actions";
import type { BrowserSidebarSession } from "./use-browser-tab-rows";

/** Legacy ACKs and durable ACKs share owner routing and the revocation gate. */
export function useBrowserListTabClose(epicId: string) {
  const { closeTab, withOwner } = useBrowserCatalogActions(epicId);
  return useCallback(
    async (session: BrowserSidebarSession, tabId: string) => {
      if (session.source === "legacy") {
        await withOwner(session.hostId, (owner) =>
          owner.closeTab(session.sessionId, tabId),
        );
      } else {
        await closeTab(
          { epicId, hostId: session.hostId, sessionId: session.sessionId },
          tabId,
        );
      }
    },
    [closeTab, epicId, withOwner],
  );
}
