import { useMemo } from "react";
import { CommentSidebarPanel } from "@/components/comments";
import { SwitcherListEmpty } from "@/components/epic-canvas/mobile/switcher-list-row";
import { selectMobileTile } from "@/components/epic-canvas/mobile/mobile-tile-selection";
import { isEpicArtifactKind } from "@/lib/artifacts/node-display";
import { useEpicCanvas } from "@/stores/epics/canvas/store";

interface SwitcherCommentsListProps {
  readonly epicId: string;
  readonly tabId: string;
}

/**
 * The artifact comes from {@link selectMobileTile}, the same rule that picked the tile on screen, rather than from the canvas store's active-pane selectors: those answer `null` whenever `activePaneId` is, while the phone still falls back to the first pane's tile and shows an artifact.
 * A terminal, a diff, a PR or an empty pane has no threads to list, and the category is permanently on the bar (see `switcher-categories`), so that case says what it is waiting for instead of rendering an empty surface.
 */
export function SwitcherCommentsList(props: SwitcherCommentsListProps) {
  const { epicId, tabId } = props;
  const canvas = useEpicCanvas(tabId);
  const shownTile = useMemo(
    () => selectMobileTile(canvas)?.ref ?? null,
    [canvas],
  );
  const artifactId =
    shownTile !== null && isEpicArtifactKind(shownTile.type)
      ? shownTile.id
      : null;

  if (artifactId === null) {
    return (
      <SwitcherListEmpty
        message="Open an artifact to see and add comments on it."
        description={null}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden pb-safe-bottom">
      <CommentSidebarPanel epicId={epicId} activeArtifactId={artifactId} />
    </div>
  );
}
