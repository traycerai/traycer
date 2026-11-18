import { useCallback } from "react";
import { useBrowserCatalogActions } from "@/hooks/browser/use-browser-catalog-actions";
import type { BrowserSidebarSession } from "./use-browser-tab-rows";

/** Every row closes on its owner, whether discovered in the catalog or live. */
export function useBrowserListTabClose(epicId: string) {
  const { closeTab } = useBrowserCatalogActions(epicId);
  return useCallback(
    async (session: BrowserSidebarSession, tabId: string) => {
      await closeTab(
        { epicId, hostId: session.hostId, sessionId: session.sessionId },
        tabId,
      );
    },
    [closeTab, epicId],
  );
}
