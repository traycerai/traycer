import {
  createContext,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
} from "react";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { type SizesByGroupId } from "@/stores/epics/canvas/types";
import {
  SplitContainer,
  type SplitPaneComponentProps,
} from "@/components/epic-canvas/canvas/split-container";
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
import { MobileEpicTileView } from "@/components/epic-canvas/mobile/mobile-epic-tile-view";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { PendingSandboxSendStrip } from "@/components/sandboxes/pending-sandbox-sends";
import { remeasureTileSurfaceGeometry } from "@/components/epic-canvas/surface-host/tile-surface-geometry-coordinator";

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
 * tree via `ResizablePanelGroup` / `ResizablePanel`. A canvas with no layout
 * gets an empty root pane, which draws the in-pane fuzzy opener and takes
 * drops like any other pane.
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
      className="canvas-token-scope relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-canvas text-canvas-foreground"
      data-testid="tile-canvas"
    >
      {/* A message sent to a staged sandbox waits here, behind its setup
          line, until the agent on the sandbox takes it. */}
      <PendingSandboxSendStrip epicId={epicId} tabId={tabId} />
      <div className="relative min-h-0 w-full flex-1">
        <TileCanvasBody
          epicId={epicId}
          tabId={tabId}
          snapshotFetchError={snapshotFetchError}
          renderLive={renderLive}
          hasActiveHandoff={hasActiveHandoff}
        />
      </div>
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
  const isMobile = useIsMobileViewport();

  const onResizeGroup = useCallback(
    (groupId: string, sizes: ReadonlyArray<number>) => {
      resizeSplitInTab(tabId, groupId, sizes);
    },
    [resizeSplitInTab, tabId],
  );
  const paneContext = useMemo(() => ({ epicId, tabId }), [epicId, tabId]);

  // Hosted chat bodies (`StableTileSurfaceHost`) paint at rects the geometry
  // coordinator reads inside a ResizeObserver callback, and a ResizeObserver
  // reports SIZE changes only. A structural change to this tree can move a
  // pane without resizing it: dropping a tab on the left edge of the only
  // other pane in a 50/50 split inserts a new pane on that side and closes
  // the emptied source, so the chat pane keeps its exact width and only its
  // `left` changes - the same position-only move `TopLevelTabHost` handles
  // for "Reverse views". The chat's `TabGroupView` is keyed by pane id and
  // never remounts, so its slot registration is not re-created either;
  // without this the hosted body stays painted at its old rect, over the pane
  // that now holds it, while the chat's own pane draws empty. Sizes matter
  // too: a middle pane between two inline (non-hosted) neighbours moves
  // without resizing when they trade width, and nothing registered resizes.
  // Layout effect, not effect: the flex geometry lands in this same commit
  // and the re-read has to see it before paint. Parent layout effects run
  // after the children's, so a slot mounted by this commit has already
  // registered and measured itself.
  useLayoutEffect(() => {
    remeasureTileSurfaceGeometry();
  }, [root, sizesByGroupId]);

  if (root === null) {
    // During a fresh create the eager-opened chat tab populates the canvas a
    // tick after mount. Hold the skeleton until it lands instead of flashing
    // the opener for a frame.
    if (hasActiveHandoff) {
      return <CanvasSkeleton />;
    }
    return <EmptyEpicRoot tabId={tabId} />;
  }
  // Below the mobile breakpoint an open epic shows exactly ONE tile
  // full-screen instead of the recursively-splitting canvas. The split tree is
  // read but never mutated, so the persisted desktop layout is unchanged on
  // return. Desktop (>=768px) falls through to the SplitContainer path below,
  // which stays byte-for-byte identical.
  if (isMobile) {
    return <MobileEpicTileView epicId={epicId} tabId={tabId} />;
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

function EmptyEpicRoot(props: { readonly tabId: string }) {
  const ensureEmptyPaneInTab = useEpicCanvasStore(
    (s) => s.ensureEmptyPaneInTab,
  );

  useEffect(() => {
    const canvas = useEpicCanvasStore.getState().canvasByTabId[props.tabId];
    if (canvas !== undefined && canvas.root !== null) return;
    ensureEmptyPaneInTab(props.tabId);
  }, [ensureEmptyPaneInTab, props.tabId]);

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
