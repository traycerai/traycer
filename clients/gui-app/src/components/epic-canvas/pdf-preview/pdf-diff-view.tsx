/**
 * PDF change summary for the git diff surfaces (single-file tile and bundle
 * rows) - the GitHub-shaped treatment, settled with the user 2026-09-03:
 * one COMPACT centered block (icon, path, "Added/Modified · size"), never a
 * full-height fake two-column diff (two multi-page viewers would look like
 * a diff while carrying none of a diff's meaning), never a modal. The one
 * action is Open: the CURRENT version in the app's own PDF viewer (the
 * workspace file tile), with the app's standard click-to-open +
 * drag-to-split mechanics. Old-version open deliberately deferred (needs a
 * file-at-revision tile kind; the user chose latest-only for now), so a
 * deleted PDF shows its status with no open affordance.
 */
import { useCallback, useMemo, type ReactNode } from "react";
import { useDraggable } from "@dnd-kit/core";
import { ExternalLink, FileTextIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { getBasename } from "@/lib/path/cross-platform-path";
import { useOpenEpicId } from "@/lib/epic-selectors";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { workspaceFileRefFromTreePath } from "@/components/epic-canvas/workspace-file/workspace-file-ref";
import {
  getPaneScopedDndId,
  getWorkspaceFileDragId,
  WORKSPACE_FILE_DND_TYPE,
  type EpicCanvasWorkspaceFileDragData,
} from "@/components/epic-canvas/dnd/dnd";
import { useDragSourceDisabled } from "@/components/epic-canvas/dnd/use-drag-source-disabled";

export interface PdfDiffViewProps {
  readonly hostId: string;
  readonly viewTabId: string;
  readonly runningDir: string;
  readonly filePath: string;
  readonly previousPath: string | null;
  /** From `gitImageDiffSides`; `null` = the side does not exist. */
  readonly oldStage: "staged" | "unstaged" | null;
  readonly newStage: "staged" | "unstaged" | null;
  /** Current (new-side) size from `GitChangedFile.sizeBytes`. */
  readonly sizeBytes: number | null;
}

function formatSizeBytes(sizeBytes: number): string {
  if (sizeBytes >= 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (sizeBytes >= 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${sizeBytes} B`;
}

function statusLabel(props: PdfDiffViewProps): string {
  if (props.oldStage === null) return "Added";
  if (props.newStage === null) return "Deleted";
  if (props.previousPath !== null && props.previousPath !== props.filePath) {
    return "Renamed";
  }
  return "Modified";
}

export function PdfDiffView(props: PdfDiffViewProps): ReactNode {
  const epicId = useOpenEpicId();
  const navigateNested = useEpicNestedFocusNavigation();
  const prepareOpenTileInTabFocusTarget = useEpicCanvasStore(
    (s) => s.prepareOpenTileInTabFocusTarget,
  );

  // The block's headline path: the surviving side's. Only a DELETED file has
  // no current side, and its label is the (old) path being removed.
  const displayPath =
    props.newStage !== null
      ? props.filePath
      : (props.previousPath ?? props.filePath);

  // Latest-only by decision: the ref points at the CURRENT file on disk, so
  // the button exists only while a current side does. The tile's own router
  // handles whatever the path turns out to be (a rename can put a non-PDF on
  // the new side - the file tile renders its true type).
  const openRef = useMemo(() => {
    if (props.newStage === null) return null;
    return workspaceFileRefFromTreePath(
      props.hostId,
      props.runningDir,
      props.filePath,
      getBasename(props.filePath),
    );
  }, [props.hostId, props.runningDir, props.filePath, props.newStage]);

  const dragData = useMemo<EpicCanvasWorkspaceFileDragData | null>(() => {
    if (openRef === null) return null;
    return {
      kind: WORKSPACE_FILE_DND_TYPE,
      epicId,
      viewTabId: props.viewTabId,
      ref: openRef,
    };
  }, [epicId, openRef, props.viewTabId]);

  const dragDisabled = useDragSourceDisabled();
  const { listeners, setNodeRef: dragRef } = useDraggable({
    id: getPaneScopedDndId(
      props.viewTabId,
      getWorkspaceFileDragId(openRef?.id ?? `pdf-diff:${props.filePath}`),
    ),
    data: dragData ?? undefined,
    disabled: openRef === null || dragDisabled,
  });

  const handleOpen = useCallback(() => {
    if (openRef === null) return;
    navigateNested(epicId, props.viewTabId, () =>
      prepareOpenTileInTabFocusTarget(props.viewTabId, openRef),
    );
  }, [
    epicId,
    navigateNested,
    openRef,
    prepareOpenTileInTabFocusTarget,
    props.viewTabId,
  ]);

  const label = statusLabel(props);
  const sizeSuffix =
    props.newStage !== null && props.sizeBytes !== null
      ? ` · ${formatSizeBytes(props.sizeBytes)}`
      : "";

  return (
    <div
      className="flex items-center justify-center p-6"
      data-testid="pdf-diff-block"
    >
      <div className="flex min-w-0 max-w-full flex-col items-center gap-2 text-center">
        <FileTextIcon className="size-8 text-muted-foreground" />
        <StartTruncatedText className="max-w-full text-ui-sm">
          {displayPath}
        </StartTruncatedText>
        {label === "Renamed" && props.previousPath !== null ? (
          <StartTruncatedText className="max-w-full text-ui-xs text-muted-foreground">
            {`from ${props.previousPath}`}
          </StartTruncatedText>
        ) : null}
        <span className="text-ui-xs text-muted-foreground">
          {label}
          {sizeSuffix}
        </span>
        {openRef !== null ? (
          <Button
            ref={dragRef}
            {...listeners}
            type="button"
            variant="outline"
            size="sm"
            onClick={handleOpen}
            aria-label={`Open ${getBasename(props.filePath)}`}
          >
            <ExternalLink className="size-4" />
            Open
          </Button>
        ) : null}
      </div>
    </div>
  );
}
