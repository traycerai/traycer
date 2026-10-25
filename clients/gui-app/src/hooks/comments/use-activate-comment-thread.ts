import { useCallback } from "react";
import type { CommentArtifactKind } from "@/lib/comments/artifact-comment-kind";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import {
  requestCommentThreadAnchorReveal,
  revealCommentThreadAnchor,
} from "@/lib/comments/comment-editor-registry";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";
import { useLeftPanelStore } from "@/stores/epics/left-panel-store";
import { useMobileSwitcherStore } from "@/stores/epics/mobile-switcher-store";

export interface ActivateCommentThreadTarget {
  readonly epicId: string;
  /** The artifact the anchor lives in - the scope threads are keyed by. */
  readonly artifactId: string;
  /** The epic view tab whose comments surface should come forward. */
  readonly viewTabId: string;
  readonly artifactType?: CommentArtifactKind;
}

/**
 * "Bring this thread forward": select it, ping its anchor in the document, and
 * put the comments surface on screen.
 *
 * Which surface that is depends on the viewport, because the two mount the
 * comments panel in different places. A desktop viewport has the left sidebar
 * beside the canvas, so selecting the panel and expanding the sidebar is enough.
 * A narrow viewport has no sidebar mounted at all - the panel lives in the
 * tab-switcher sheet's Comments category - so the sheet has to be opened too;
 * selecting the panel alone would write a selection nothing on screen reads, and
 * the tap would look like it did nothing. Both branches select through the same
 * left-panel store the sheet reads its category from, so there is one selection
 * either way.
 */
export function useActivateCommentThread(
  target: ActivateCommentThreadTarget,
): (threadId: string) => void {
  const { epicId, artifactId, artifactType } = target;
  const openComments = useOpenArtifactComments(target);
  const setActiveThread = useCommentThreadsStore((s) => s.setActiveThread);
  const setFlashThread = useCommentThreadsStore((s) => s.setFlashThread);
  return useCallback(
    (threadId: string) => {
      setActiveThread(epicId, threadId);
      setFlashThread(epicId, threadId);
      openComments();
      if (artifactType === "html" || artifactType === "canvas") {
        requestCommentThreadAnchorReveal(epicId, artifactId, threadId);
        return;
      }
      revealCommentThreadAnchor(epicId, artifactId, threadId);
    },
    [
      epicId,
      artifactId,
      artifactType,
      openComments,
      setActiveThread,
      setFlashThread,
    ],
  );
}

/** Reveal the shared comments sidebar without changing document interaction mode. */
function useOpenArtifactComments(
  target: ActivateCommentThreadTarget,
): () => void {
  const { epicId, artifactId, viewTabId } = target;
  const mobile = useIsMobileViewport();
  return useCallback(() => {
    useCommentThreadsStore.getState().setCurrentArtifact(epicId, artifactId);
    const panels = useLeftPanelStore.getState();
    panels.revealCommentsPanel(viewTabId);
    // The sheet layers over everything the tile shows, a fullscreen board
    // included - the sidebar panel alone is not mounted on a narrow
    // viewport, so selecting it without the sheet would look like nothing
    // happened.
    if (mobile) {
      panels.setActivePanelId(viewTabId, "comments");
      useMobileSwitcherStore.getState().setOpen(viewTabId, true);
    } else panels.setActivePanelIdAndExpand(viewTabId, "comments");
  }, [epicId, artifactId, viewTabId, mobile]);
}
