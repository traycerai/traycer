import { useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import { useDraggable } from "@dnd-kit/core";
import type { GitChangedFile } from "@traycer/protocol/host";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { makeGitFileDiffTileForFile } from "@/lib/git/git-diff-tile";
import { gitChangedFileTooltipContent } from "@/lib/git/panel-file-rendering";
import type { HighlightRanges } from "@/lib/git/path-highlight";
import { FilePathTooltip } from "@/components/file-path-tooltip";
import {
  GIT_DIFF_TILE_DND_TYPE,
  getGitDiffTileDragId,
  type EpicCanvasGitDiffTileDragData,
} from "@/components/epic-canvas/dnd/dnd";
import { GitChangedFileRow } from "./git-changed-file-row";

export interface FileRowProps {
  readonly epicId: string;
  readonly viewTabId: string;
  readonly hostId: string;
  readonly runningDir: string;
  readonly file: GitChangedFile;
  readonly active: boolean;
  /** Filter match ranges into `file.path`; empty when no filter is active. */
  readonly pathRanges: HighlightRanges;
  readonly nested: boolean;
}

export function FileRow(props: FileRowProps): ReactNode {
  const openPreview = useEpicCanvasStore((s) => s.openTilePreviewInTab);
  const openPinned = useEpicCanvasStore((s) => s.openTileInTab);
  const tile = useMemo(
    () =>
      makeGitFileDiffTileForFile({
        hostId: props.hostId,
        runningDir: props.runningDir,
        file: props.file,
      }),
    [props.hostId, props.file, props.runningDir],
  );

  const onClick = useCallback(() => {
    openPreview(props.viewTabId, tile);
  }, [openPreview, props.viewTabId, tile]);

  const onDoubleClick = useCallback(() => {
    openPinned(props.viewTabId, tile);
  }, [openPinned, props.viewTabId, tile]);

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
