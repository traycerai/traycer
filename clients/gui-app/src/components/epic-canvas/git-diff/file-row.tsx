import { useCallback, useMemo } from "react";
import type { MouseEvent, ReactNode } from "react";
import { useDraggable } from "@dnd-kit/core";
import type { GitChangedFile } from "@traycer/protocol/host";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { modifiersFromMouseEvent } from "@/lib/canvas/tile-open/intent";
import { makeGitFileDiffTileForFile } from "@/lib/git/git-diff-tile";
import type { GitDiffRepositoryContext } from "@/stores/epics/canvas/types";
import { gitChangedFileTooltipContent } from "@/lib/git/panel-file-rendering";
import type { HighlightRanges } from "@/lib/git/path-highlight";
import { FilePathTooltip } from "@/components/file-path-tooltip";
import {
  GIT_DIFF_TILE_DND_TYPE,
  getGitDiffTileDragId,
  getPaneScopedDndId,
  type EpicCanvasGitDiffTileDragData,
} from "@/components/epic-canvas/dnd/dnd";
import { useDragSourceDisabled } from "@/components/epic-canvas/dnd/use-drag-source-disabled";
import { GitChangedFileRow } from "./git-changed-file-row";

export interface FileRowProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly hostId: string;
  readonly runningDir: string;
  readonly repositoryContext: GitDiffRepositoryContext | null;
  readonly file: GitChangedFile;
  readonly active: boolean;
  /** Filter match ranges into `file.path`; empty when no filter is active. */
  readonly pathRanges: HighlightRanges;
  readonly nested: boolean;
}

export function FileRow(props: FileRowProps): ReactNode {
  const { openTile } = useEpicTileNavigation();
  const tile = useMemo(
    () =>
      makeGitFileDiffTileForFile({
        hostId: props.hostId,
        runningDir: props.runningDir,
        file: props.file,
        repositoryContext: props.repositoryContext,
      }),
    [props.hostId, props.file, props.repositoryContext, props.runningDir],
  );

  const onClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      openTile({
        node: tile,
        target: { tabId: props.viewTabId },
        gesture: "single",
        modifiers: modifiersFromMouseEvent(event),
        placement: null,
        dedupe: true,
        source: "direct_ui",
      });
    },
    [openTile, props.viewTabId, tile],
  );

  const onDoubleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      openTile({
        node: tile,
        target: { tabId: props.viewTabId },
        gesture: "double",
        modifiers: modifiersFromMouseEvent(event),
        placement: null,
        dedupe: true,
        source: "direct_ui",
      });
    },
    [openTile, props.viewTabId, tile],
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
    disabled: dragDisabled,
  });

  return (
    <FilePathTooltip
      content={gitChangedFileTooltipContent(props.file)}
      side="right"
    >
      <div
        ref={dragRef}
        {...listeners}
        data-testid={`file-row-${props.file.path}`}
      >
        <GitChangedFileRow
          file={props.file}
          density="panel"
          active={props.active}
          leading={null}
          trailing={null}
          showStats
          pathRanges={props.pathRanges}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          ariaExpanded={undefined}
          nested={props.nested}
          className={undefined}
        />
      </div>
    </FilePathTooltip>
  );
}
