import {
  GIT_DIFF_TILE_DND_TYPE,
  getGitDiffTileDragId,
  getPaneScopedDndId,
  type EpicCanvasGitDiffTileDragData,
} from "@/components/epic-canvas/dnd/dnd";
import { useDragSourceDisabled } from "@/components/epic-canvas/dnd/use-drag-source-disabled";
import { Button } from "@/components/ui/button";
import {
  gitBundleGroupLabel,
  makeGitBundleDiffTile,
} from "@/lib/git/git-diff-tile";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { modifiersFromMouseEvent } from "@/lib/canvas/tile-open/intent";
import type {
  GitDiffBundleGroup,
  GitDiffRepositoryContext,
} from "@/stores/epics/canvas/types";
import { useDraggable } from "@dnd-kit/core";
import { FileDiff } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { useCallback, useMemo } from "react";

export interface BundleOpenButtonProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly hostId: string;
  readonly runningDir: string;
  readonly group: GitDiffBundleGroup;
  readonly repositoryContext: GitDiffRepositoryContext | null;
  readonly disabled: boolean;
}

export function BundleOpenButton(props: BundleOpenButtonProps): ReactNode {
  const { openTile } = useEpicTileNavigation();
  const tile = useMemo(
    () =>
      makeGitBundleDiffTile({
        hostId: props.hostId,
        runningDir: props.runningDir,
        bundleGroup: props.group,
        repositoryContext: props.repositoryContext,
      }),
    [props.hostId, props.group, props.repositoryContext, props.runningDir],
  );
  const dragData = useMemo<EpicCanvasGitDiffTileDragData>(
    () => ({
      kind: GIT_DIFF_TILE_DND_TYPE,
      epicId: props.epicId,
      viewTabId: props.viewTabId,
      tile,
    }),
    [props.epicId, props.viewTabId, tile],
  );
  const dragDisabled = useDragSourceDisabled();
  const { listeners, setNodeRef: dragRef } = useDraggable({
    id: getPaneScopedDndId(props.viewTabId, getGitDiffTileDragId(tile.id)),
    data: dragData,
    disabled: props.disabled || dragDisabled,
  });
  const openBundle = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      openTile({
        node: tile,
        target: { tabId: props.viewTabId },
        gesture: "explicit",
        modifiers: modifiersFromMouseEvent(event),
        placement: null,
        dedupe: true,
        source: "direct_ui",
      });
    },
    [openTile, props.viewTabId, tile],
  );

  return (
    <Button
      ref={dragRef}
      {...listeners}
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={`Open ${gitBundleGroupLabel(props.group)}`}
      disabled={props.disabled}
      onClick={openBundle}
      className="text-muted-foreground hover:text-foreground"
    >
      <FileDiff className="size-4" />
    </Button>
  );
}
