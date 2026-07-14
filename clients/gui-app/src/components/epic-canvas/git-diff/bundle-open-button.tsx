import {
  GIT_DIFF_TILE_DND_TYPE,
  getGitDiffTileDragId,
  type EpicCanvasGitDiffTileDragData,
} from "@/components/epic-canvas/dnd/dnd";
import { Button } from "@/components/ui/button";
import {
  gitBundleGroupLabel,
  makeGitBundleDiffTile,
} from "@/lib/git/git-diff-tile";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type {
  GitDiffBundleGroup,
  GitDiffRepositoryContext,
} from "@/stores/epics/canvas/types";
import { useDraggable } from "@dnd-kit/core";
import { FileDiff } from "lucide-react";
import type { ReactNode } from "react";
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
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );
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
  const { listeners, setNodeRef: dragRef } = useDraggable({
    id: getGitDiffTileDragId(tile.id),
    data: dragData,
    disabled: props.disabled,
  });
  const openBundle = useCallback(() => {
    navigateNested(props.epicId, props.viewTabId, () =>
      prepareOpenTileInTabFocusTarget(props.viewTabId, tile),
    );
  }, [
    navigateNested,
    prepareOpenTileInTabFocusTarget,
    props.epicId,
    props.viewTabId,
    tile,
  ]);

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
