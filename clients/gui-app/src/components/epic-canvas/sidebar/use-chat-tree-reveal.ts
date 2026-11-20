import { useLayoutEffect } from "react";
import type { ChatTreeVirtualApi } from "@/components/epic-canvas/sidebar/chat-tree-virtual-context";
import { revealSidebarNode } from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";
import {
  clearSidebarNodeRevealRequest,
  useSidebarNodeRevealRequest,
} from "@/stores/epics/sidebar-node-reveal-store";

/**
 * Serves the tab's sidebar reveal request: scrolls the row into view, flashes
 * it and clears the request. The panel has already opened the row's ancestors.
 *
 * Only rendered rows are in the DOM. A row outside the window is scrolled to
 * first, and the next run, once the window has moved, finds it and reveals it
 * exactly as a rendered row is: `scrollIntoView` to the nearest edge, then the
 * flash. A row not in the rows yet (its ancestors still opening, its projection
 * on its way) leaves the request for a later run.
 *
 * A hidden tab has no layout to scroll, so a row it has not rendered waits for
 * the tab to show.
 */
export function useChatTreeReveal(
  api: ChatTreeVirtualApi,
  tabId: string,
): void {
  const request = useSidebarNodeRevealRequest(tabId);
  const {
    virtualizer,
    model,
    regionElement,
    indexOfNodeId,
    scrollToIndex,
    rangeVersion,
  } = api;
  useLayoutEffect(() => {
    if (request === null) return;
    const region = regionElement();
    if (region === null) return;
    if (revealSidebarNode(region, request.nodeId, request.nonce)) {
      clearSidebarNodeRevealRequest(tabId, request.nonce);
      return;
    }
    if ((virtualizer.scrollRect?.height ?? 0) <= 0) return;
    const index = indexOfNodeId(request.nodeId);
    if (index >= 0) scrollToIndex(index, "auto");
  }, [
    request,
    tabId,
    virtualizer,
    model,
    regionElement,
    indexOfNodeId,
    scrollToIndex,
    rangeVersion,
  ]);
}
