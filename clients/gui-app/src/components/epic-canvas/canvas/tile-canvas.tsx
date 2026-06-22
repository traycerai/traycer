import { createContext, use, useCallback, useEffect, useMemo } from "react";
import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { type SizesByGroupId } from "@/stores/epics/canvas/types";
import { makeBlankTileRef } from "@/stores/epics/canvas/tile-schema/blank-tile";
import {
  SplitContainer,
  type SplitPaneComponentProps,
} from "@/components/epic-canvas/canvas/split-container";
import {
  getEmptyShellDropId,
  type EpicCanvasDropTargetData,
} from "@/components/epic-canvas/dnd/dnd";
import { useEpicHasArtifactRecords } from "@/lib/epic-selectors";
import { useSnapshotLoading } from "@/components/epic-canvas/snapshots/snapshot-loading-context-value";
import { SnapshotErrorBanner } from "@/components/epic-canvas/snapshots/snapshot-error-banner";
import type { SnapshotFetchError } from "@/stores/epics/open-epic/store";
import {
  selectHasActiveInitialChatHandoffForEpic,
  useInitialChatHandoffStore,
} from "@/stores/epics/initial-chat-handoff-store";
import { CanvasSkeleton } from "@/components/epic-canvas/skeletons/canvas-skeleton";
import { TabGroupView } from "@/components/epic-canvas/canvas/tab-group-view";
import { EpicCanvasDragInteractionShield } from "@/components/epic-canvas/dnd/drag-interaction-shield";
import { useEmptyShellDropActive } from "@/components/epic-canvas/dnd/dnd-store";

interface TileCanvasPaneContextValue {
  readonly epicId: string;
  readonly tabId: string;
}

const TileCanvasPaneContext = createContext<TileCanvasPaneContextValue | null>(
  null,
);

interface TileCanvasProps {
  readonly epicId: string;
  readonly tabId: string;
}

/**
 * Epic-scoped tab-group canvas. Recursively renders the binary split
 * tree via `ResizablePanelGroup` / `ResizablePanel`. When the canvas is
 * empty, renders the empty-shell drop target which seeds a root group
 * on first drop. When the epic has zero artifacts at all, it first seeds a
 * blank root tab so the normal in-pane fuzzy opener is shown instead.
 */
export function TileCanvas(props: TileCanvasProps) {
  const { epicId, tabId } = props;
  const { snapshotLoaded, snapshotFetchError } = useSnapshotLoading();
  const hasActiveHandoff = useInitialChatHandoffStore((state) =>
    selectHasActiveInitialChatHandoffForEpic(state, epicId),
  );
  // Render the live canvas as soon as the epic snapshot is loaded OR a
  // freshly-created epic still has a live initial-chat handoff. The latter
  // paints the eager-opened chat tab (from the canvas store, NOT the epic
  // chats slice) during the epic-snapshot load - its `pendingCreateArtifactIds`
  // mark suppresses the remote-deleted branch while the real chat lands, so the
  // tab survives the empty initial snapshot.
  const renderLive = snapshotLoaded || hasActiveHandoff;
  return (
    <div
      className="canvas-token-scope relative h-full min-h-0 w-full overflow-hidden rounded-t-lg border border-canvas-border/70 bg-canvas text-canvas-foreground"
      data-testid="tile-canvas"
    >
      <TileCanvasBody
        epicId={epicId}
        tabId={tabId}
        snapshotFetchError={snapshotFetchError}
        renderLive={renderLive}
        hasActiveHandoff={hasActiveHandoff}
      />
      <EpicCanvasDragInteractionShield />
    </div>
  );
}

function TileCanvasBody(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly snapshotFetchError: SnapshotFetchError | null;
  readonly renderLive: boolean;
  readonly hasActiveHandoff: boolean;
}) {
  if (props.snapshotFetchError !== null) {
    return (
      <SnapshotErrorBanner
        error={props.snapshotFetchError}
        className={undefined}
      />
    );
  }
  if (props.renderLive) {
    return (
      <TileCanvasLive
        epicId={props.epicId}
        tabId={props.tabId}
        hasActiveHandoff={props.hasActiveHandoff}
      />
    );
  }
  return <CanvasSkeleton />;
}

const EMPTY_SIZES: SizesByGroupId = {};

function TileCanvasLive(
  props: TileCanvasProps & { hasActiveHandoff: boolean },
) {
  const { epicId, tabId, hasActiveHandoff } = props;
  // Subscribe to `root` and `sizesByGroupId` separately (NOT the whole
  // canvas state): tile-payload churn in `tilesByInstanceId` (rename, diff
  // view state) must not re-render the layout layer - per-pane views
  // subscribe to their own payloads.
  const root = useEpicCanvasStore((s) => s.canvasByTabId[tabId]?.root ?? null);
  const sizesByGroupId = useEpicCanvasStore(
    (s) => s.canvasByTabId[tabId]?.sizesByGroupId ?? EMPTY_SIZES,
  );
  const resizeSplitInTab = useEpicCanvasStore((s) => s.resizeSplitInTab);
  const hasRecords = useEpicHasArtifactRecords();

  const onResizeGroup = useCallback(
    (groupId: string, sizes: ReadonlyArray<number>) => {
      resizeSplitInTab(tabId, groupId, sizes);
    },
    [resizeSplitInTab, tabId],
  );
  const paneContext = useMemo(() => ({ epicId, tabId }), [epicId, tabId]);

  if (root === null) {
    // During a fresh create the eager-opened chat tab populates the canvas a
    // tick after mount. Hold the skeleton until it lands instead of flashing
    // the blank root opener / empty-shell for a frame.
    if (hasActiveHandoff) {
      return <CanvasSkeleton />;
    }
    if (!hasRecords) {
      return <EmptyEpicBlankRoot tabId={tabId} />;
    }
    return <EmptyShell epicId={epicId} tabId={tabId} />;
  }
  return (
    <TileCanvasPaneContext.Provider value={paneContext}>
      <SplitContainer
        root={root}
        sizesByGroupId={sizesByGroupId}
        PaneComponent={TileCanvasPane}
        onResizeGroup={onResizeGroup}
      />
    </TileCanvasPaneContext.Provider>
  );
}

function EmptyEpicBlankRoot(props: { readonly tabId: string }) {
  const openTileInTab = useEpicCanvasStore((s) => s.openTileInTab);

  useEffect(() => {
    const canvas = useEpicCanvasStore.getState().canvasByTabId[props.tabId];
    if (canvas !== undefined && canvas.root !== null) return;
    openTileInTab(props.tabId, makeBlankTileRef());
  }, [openTileInTab, props.tabId]);

  return <CanvasSkeleton />;
}

function TileCanvasPane(props: SplitPaneComponentProps) {
  const context = use(TileCanvasPaneContext);
  if (context === null) return null;
  return (
    <TabGroupView
      epicId={context.epicId}
      tabId={context.tabId}
      pane={props.pane}
    />
  );
}

interface EmptyShellProps {
  readonly epicId: string;
  readonly tabId: string;
}

/**
 * Drop zone shown when the canvas has no root group. The first sidebar-node
 * drop seeds the root group with the dragged artifact. Pointer-only hit
 * testing comes from the root context's collision detection.
 */
function EmptyShell(props: EmptyShellProps) {
  const { epicId, tabId } = props;
  const dropData = useMemo<EpicCanvasDropTargetData>(
    () => ({ kind: "empty-shell", epicId, viewTabId: tabId }),
    [epicId, tabId],
  );
  const { setNodeRef: dropRef } = useDroppable({
    id: getEmptyShellDropId(epicId, tabId),
    data: dropData,
  });
  const active = useEmptyShellDropActive();

  return (
    <div
      ref={dropRef}
      data-testid="empty-shell"
      className={cn(
        "flex h-full min-h-0 w-full items-center justify-center border-2 border-dashed border-canvas-border/50 bg-canvas text-ui-sm text-muted-foreground transition-colors",
        active && "border-primary/60 bg-primary/5 text-foreground",
      )}
    >
      <div className="flex flex-col items-center gap-1 text-center">
        <p className="text-ui-sm font-medium text-foreground">No tabs open</p>
        <p className="text-ui-xs text-muted-foreground">
          Drag an artifact from the sidebar to open it here.
        </p>
      </div>
    </div>
  );
}
