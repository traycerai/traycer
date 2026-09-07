import { useCallback } from "react";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { revealCommentThreadAnchor } from "@/lib/comments/comment-editor-registry";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";
import { useMobileSwitcherStore } from "@/stores/epics/mobile-switcher-store";

export interface ActivateCommentThreadTarget {
  readonly epicId: string;
  /** The artifact the anchor lives in - the scope threads are keyed by. */
  readonly artifactId: string;
  /** The epic view tab whose comments surface should come forward. */
  readonly viewTabId: string;
}

/**
 * Select the thread and put comments on screen. Narrow viewports must also open the tab-switcher sheet; the sidebar is not mounted there.
 */
export function useActivateCommentThread(
  target: ActivateCommentThreadTarget,
): (threadId: string) => void {
  const { epicId, artifactId, viewTabId } = target;
  const isMobileViewport = useIsMobileViewport();
  const setActiveThread = useCommentThreadsStore((s) => s.setActiveThread);
  const setFlashThread = useCommentThreadsStore((s) => s.setFlashThread);
  const revealCommentsPanel = useLeftPanelStore((s) => s.revealCommentsPanel);
  const setActivePanelId = useLeftPanelStore((s) => s.setActivePanelId);
  const setActivePanelIdAndExpand = useLeftPanelStore(
    (s) => s.setActivePanelIdAndExpand,
  );
  const setSwitcherOpen = useMobileSwitcherStore((s) => s.setOpen);

  return useCallback(
    (threadId: string) => {
      setActiveThread(epicId, threadId);
      setFlashThread(epicId, threadId);
      revealCommentsPanel(viewTabId);
      if (isMobileViewport) {
        setActivePanelId(viewTabId, "comments");
        setSwitcherOpen(viewTabId, true);
      } else {
        setActivePanelIdAndExpand(viewTabId, "comments");
      }
      revealCommentThreadAnchor(epicId, artifactId, threadId);
    },
    [
      epicId,
      artifactId,
      viewTabId,
      isMobileViewport,
      setActiveThread,
      setFlashThread,
      revealCommentsPanel,
      setActivePanelId,
      setActivePanelIdAndExpand,
      setSwitcherOpen,
    ],
  );
}
