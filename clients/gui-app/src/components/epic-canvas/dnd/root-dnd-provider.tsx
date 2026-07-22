/**
 * THE single DndContext for the app. Mounted once in `app-shell.tsx`,
 * wrapping the header tab strip and every route surface, so canvas tiles,
 * sidebar sources, rail items, header tabs, and tear-off all share one
 * context - no geometry bridges between provider islands.
 *
 * The provider holds ZERO React state: drag lifecycle handlers write into
 * the ephemeral `dnd-store` (narrow per-target selectors keep preview ticks
 * scoped to the hovered pane) and track the last resolved drop in a ref.
 * Collision detection + the collision-pass pointer stash live in
 * `root-dnd-collision.ts`; commits live in `root-dnd-commits.ts` and read
 * stores imperatively.
 */
import {
  ARTIFACT_TAB_DND_TYPE,
  CHAT_ARTIFACT_DND_TYPE,
  SIDEBAR_NODE_DND_TYPE,
  readEpicCanvasDragSourceData,
  readEpicCanvasDropTargetData,
  type EpicCanvasDragSourceData,
  type EpicCanvasDropTargetData,
  type PointLike,
  type RectLike,
} from "@/components/epic-canvas/dnd/dnd";
import { useEpicDndStore } from "@/components/epic-canvas/dnd/dnd-store";
import { EpicRootDragOverlayContent } from "@/components/epic-canvas/dnd/drag-overlay-chip";
import {
  EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE,
  EpicCanvasPointerSensor,
} from "@/components/epic-canvas/dnd/epic-canvas-pointer-sensor";
import {
  clearLastCollisionPointerPoint,
  epicRootCollisionDetection,
  getLastCollisionPointerPoint,
  readActiveDragSource,
} from "@/components/epic-canvas/dnd/root-dnd-collision";
import {
  canDropOnHeaderStrip,
  commitHeaderStripDrop,
  commitResolvedCanvasDrop,
  commitSidebarReparentDrop,
  isCanvasDropCompatible,
  isLeftPanelDropNoop,
  resolveCanvasDropPreview,
  resolveOverlayTileForSource,
  type ResolvedEpicCanvasDrop,
} from "@/components/epic-canvas/dnd/root-dnd-commits";
import {
  clearSidebarReparentPreview,
  clearSpringLoad,
  readSidebarReparentTarget,
  updateSidebarReparentPreview,
  type LastReparentDrop,
  type ReparentRefs,
  type SpringLoadEntry,
} from "@/components/epic-canvas/dnd/root-dnd-reparent-preview";
import {
  readHeaderTabDragData,
  readHeaderTabSlotDropData,
  resolveHeaderStripDropIndex,
  type HeaderTabDragData,
} from "@/components/layout/tabs/header-tab-dnd";
import {
  EdgeSplitDwellMachine,
  edgeSplitBrowserTimer,
  type EdgeSplitDwellState,
} from "@/components/layout/tabs/edge-split-dwell";
import {
  readTopLevelTabDropTarget,
  resolveValidatedTopLevelTabDrop,
  type TopLevelEdgeSplitTarget,
  type TopLevelFillableTarget,
} from "@/components/layout/tabs/top-level-tab-dnd";
import {
  activatePreparedPairTabIntent,
  existingEpicTabIntent,
  navigateToTabIntent,
} from "@/lib/tab-navigation";
import { useEpicNestedFocusNavigation } from "@/hooks/epic/use-epic-nested-focus-navigation";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import {
  getTabCommandLedger,
  subscribeToTabCommandLedger,
} from "@/stores/tabs/tab-command-coordinator";
import { subscribeTabSplitCompatibility } from "@/stores/tabs/tab-split-compatibility";
import { subscribeTabStructuralLocks } from "@/stores/tabs/tab-structural-lock";
import { type SplitStripItem } from "@/stores/tabs/layout";
import { getHeaderTabs } from "@/stores/tabs/use-header-tabs";
import { tabResolveIntent } from "@/stores/tabs/registry";
import type { TabRef } from "@/stores/tabs/types";
import { v4 as uuidv4 } from "uuid";
import {
  DndContext,
  DragOverlay,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import { snapCenterToCursor } from "@dnd-kit/modifiers";
import { useNavigate, type UseNavigateResult } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";

/**
 * The artifact-reference drag source can come from wide in-content rows/cards,
 * so dnd-kit's default overlay anchoring (chip top-left pinned to the dragged
 * node's top-left) can leave the chip far from the pointer when the row is
 * grabbed away from its leading edge. Center the overlay chip on the cursor for
 * THIS source only - every other source (sidebar rows, tabs, tiles, rail items)
 * keeps its grab-anchored overlay. Reuses dnd-kit's official
 * `snapCenterToCursor`; the wrapper only gates which source it runs for.
 */
const snapChatArtifactChipToCursor: Modifier = (args) => {
  const source = readEpicCanvasDragSourceData(args.active?.data.current);
  return source?.kind === CHAT_ARTIFACT_DND_TYPE
    ? snapCenterToCursor(args)
    : args.transform;
};

function readOverRect(
  event: DragMoveEvent | DragOverEvent | DragEndEvent,
): RectLike | null {
  return event.over?.rect ?? null;
}

function findDroppableElement(id: string | number): Element | null {
  return document.querySelector(
    `[data-dnd-droppable-id="${CSS.escape(String(id))}"]`,
  );
}

type DragUpdateEvent = DragMoveEvent | DragOverEvent | DragEndEvent;

function compatibleCanvasTarget(
  source: EpicCanvasDragSourceData,
  target: EpicCanvasDropTargetData | null,
  point: PointLike | null,
): {
  readonly target: EpicCanvasDropTargetData;
  readonly point: PointLike;
} | null {
  if (target === null || point === null) return null;
  return isCanvasDropCompatible(source, target) ? { target, point } : null;
}

/**
 * Preview resolution for a typed canvas/rail source: header-slot hovers feed
 * the header strip index; everything else resolves through
 * `resolveCanvasDropPreview` and lands in the canvas preview + the
 * last-resolved-drop ref the commit reads at drag end.
 */
function updateCanvasSourcePreview(
  source: EpicCanvasDragSourceData,
  event: DragUpdateEvent,
  point: PointLike | null,
  refs: ReparentRefs,
): void {
  const dndStore = useEpicDndStore.getState();
  const over = event.over;
  const overData: unknown = over?.data.current;
  if (source.kind === SIDEBAR_NODE_DND_TYPE) {
    const reparentTarget =
      over === null ? null : readSidebarReparentTarget(overData);
    if (reparentTarget !== null) {
      updateSidebarReparentPreview(source, reparentTarget, refs);
      return;
    }
  }
  // Not over a sidebar target (or not a sidebar-node source): clear any reparent
  // highlight so switching from a row hover back to canvas works.
  clearSidebarReparentPreview(refs);
  const headerSlot = over === null ? null : readHeaderTabSlotDropData(overData);
  if (headerSlot !== null && canDropOnHeaderStrip(source) && point !== null) {
    refs.lastResolved.current = null;
    dndStore.dropPreviewChanged(null);
    dndStore.headerStripDropIndexChanged(
      resolveHeaderStripDropIndex({
        slot: headerSlot,
        pointerX: point.x,
        slotRect: readOverRect(event),
        sourceIndex: null,
      }),
    );
    return;
  }
  dndStore.headerStripDropIndexChanged(null);
  const targetAtPoint = compatibleCanvasTarget(
    source,
    over === null ? null : readEpicCanvasDropTargetData(overData),
    point,
  );
  if (targetAtPoint === null) {
    refs.lastResolved.current = null;
    dndStore.dropPreviewChanged(null);
    return;
  }
  const { target, point: resolvedPoint } = targetAtPoint;
  const preview = resolveCanvasDropPreview({
    source,
    target,
    point: resolvedPoint,
    targetRect: readOverRect(event),
    targetElement:
      target.kind === "left-panel-group" && over !== null
        ? findDroppableElement(over.id)
        : null,
    activeRect: event.active.rect.current.translated ?? null,
  });
  if (isLeftPanelDropNoop(source, preview)) {
    refs.lastResolved.current = null;
    dndStore.dropPreviewChanged(null);
    return;
  }
  refs.lastResolved.current = { source, target, preview };
  dndStore.dropPreviewChanged(preview);
}

function updateHeaderTabSourcePreview(
  headerTab: HeaderTabDragData,
  event: DragUpdateEvent,
  point: PointLike | null,
  edgeDwell: EdgeSplitDwellMachine,
): void {
  const dndStore = useEpicDndStore.getState();
  const over = event.over;
  const topLevelTarget =
    over === null ? null : readTopLevelTabDropTarget(over.data.current);
  const validDrop =
    topLevelTarget === null
      ? null
      : resolveLiveTopLevelDrop(headerTab, topLevelTarget);
  if (validDrop !== null) {
    dndStore.headerStripDropIndexChanged(null);
    if (validDrop.target.kind === "top-level-fillable-slot") {
      edgeDwell.reset();
      return;
    }
    edgeDwell.setTargetValidator(
      (candidate) => resolveLiveTopLevelDrop(headerTab, candidate) !== null,
    );
    edgeDwell.observe(validDrop.target);
    return;
  }
  edgeDwell.reset();
  const headerSlot =
    over === null ? null : readHeaderTabSlotDropData(over.data.current);
  if (headerSlot === null || point === null) {
    dndStore.headerStripDropIndexChanged(null);
    return;
  }
  dndStore.headerStripDropIndexChanged(
    resolveHeaderStripDropIndex({
      slot: headerSlot,
      pointerX: point.x,
      slotRect: readOverRect(event),
      sourceIndex: headerTab.index,
    }),
  );
}

function layoutFromTabsStore() {
  const state = useTabsStore.getState();
  return {
    version: 2,
    items: state.items,
    activeItemId: state.activeItemId,
    systemTabs: state.systemTabs,
  } as const;
}

function resolveLiveTopLevelDrop(
  headerTab: HeaderTabDragData,
  target: TopLevelEdgeSplitTarget | TopLevelFillableTarget,
) {
  return resolveValidatedTopLevelTabDrop(
    headerTab,
    target,
    layoutFromTabsStore(),
  );
}

function fillTopLevelSlot(
  source: TabRef,
  target: TopLevelFillableTarget,
  activate: (ref: TabRef) => void,
): void {
  const layout = layoutFromTabsStore();
  const split =
    layout.items.find(
      (item): item is SplitStripItem =>
        item.kind === "split" && item.id === target.splitId,
    ) ?? null;
  if (split === null) return;
  const targetSide = target.side === "left" ? split.left : split.right;
  if (targetSide.kind === "tab") return;
  const focused = split.focusedSide === target.side;
  if (!tabCommandCoordinator.fillSplitSide({ ...target, ref: source })) return;
  if (!focused) return;
  activate(source);
}

function activateHeaderRef(ref: TabRef, activate: (tab: TabRef) => void): void {
  activate(ref);
}

function commitHeaderTabDrop(input: {
  readonly event: DragEndEvent;
  readonly headerStripIndex: number | null;
  readonly navigate: UseNavigateResult<string>;
  readonly edgeDwell: EdgeSplitDwellMachine;
}): void {
  const headerTab = readHeaderTabDragData(input.event.active.data.current);
  const target =
    input.event.over === null
      ? null
      : readTopLevelTabDropTarget(input.event.over.data.current);
  const validDrop =
    headerTab === null || target === null
      ? null
      : resolveLiveTopLevelDrop(headerTab, target);
  const activate = (ref: TabRef): void => {
    const tab = getHeaderTabs().find(
      (candidate) => candidate.kind === ref.kind && candidate.id === ref.id,
    );
    if (tab !== undefined) {
      navigateToTabIntent(input.navigate, tabResolveIntent(tab), undefined);
    }
  };
  if (validDrop?.target.kind === "top-level-fillable-slot") {
    fillTopLevelSlot(validDrop.source, validDrop.target, (ref) =>
      activateHeaderRef(ref, activate),
    );
    return;
  }
  if (validDrop?.target.kind === "top-level-edge-split") {
    commitHeaderEdgeSplit(
      validDrop.source,
      validDrop.target,
      input.edgeDwell,
      input.navigate,
    );
    return;
  }
  if (headerTab !== null && input.headerStripIndex !== null) {
    tabCommandCoordinator.reorderStripItem({
      itemId: headerTab.stripItemId,
      targetIndex: input.headerStripIndex,
    });
  }
}

function commitHeaderEdgeSplit(
  sourceRef: TabRef,
  target: TopLevelEdgeSplitTarget,
  edgeDwell: EdgeSplitDwellMachine,
  navigate: UseNavigateResult<string>,
): void {
  const committedTarget = edgeDwell.commit(target);
  if (committedTarget === null) {
    return;
  }
  const sourceTab = getHeaderTabs().find(
    (tab) => tab.kind === sourceRef.kind && tab.id === sourceRef.id,
  );
  if (sourceTab === undefined) return;
  activatePreparedPairTabIntent(
    navigate,
    {
      left:
        committedTarget.side === "left" ? sourceRef : committedTarget.targetRef,
      right:
        committedTarget.side === "right"
          ? sourceRef
          : committedTarget.targetRef,
      focusedRef: sourceRef,
      splitId: `split:${uuidv4()}`,
      leftRatio: 0.5,
    },
    tabResolveIntent(sourceTab),
    undefined,
  );
}

interface RootDndProviderProps {
  readonly children: ReactNode;
}

export function RootDndProvider(props: RootDndProviderProps) {
  const navigate = useNavigate();
  const navigateNested = useEpicNestedFocusNavigation();
  const lastResolvedDropRef = useRef<ResolvedEpicCanvasDrop | null>(null);
  const lastReparentDropRef = useRef<LastReparentDrop | null>(null);
  const springLoadRef = useRef<SpringLoadEntry | null>(null);
  const edgeDwell = useMemo(
    () =>
      new EdgeSplitDwellMachine((state: EdgeSplitDwellState) => {
        useEpicDndStore
          .getState()
          .topLevelEdgeSplitPreviewChanged(
            state.kind === "preview" ? state.target : null,
          );
      }, edgeSplitBrowserTimer),
    [],
  );
  // Stable bundle (the inner refs never change identity) so the preview helpers
  // take one object instead of three positional ref params.
  const reparentRefsRef = useRef<ReparentRefs>({
    lastResolved: lastResolvedDropRef,
    lastReparent: lastReparentDropRef,
    springLoad: springLoadRef,
  });
  const reparentRefs = reparentRefsRef.current;
  // A spring-load timer armed mid-drag must not survive the provider: if it
  // unmounts (route change / epic close) before drag end/cancel clears it, the
  // pending `setTimeout` would fire and `expand()` a stale tab/panel.
  useEffect(
    () => () => {
      clearSpringLoad(springLoadRef);
      edgeDwell.reset();
    },
    [edgeDwell],
  );
  useEffect(() => {
    // A coordinator transaction fires a mid-transaction notify while
    // suppressionDepth is still 1 (before the layout write lands), for which
    // resolveValidatedTopLevelTabDrop always returns null. Revalidating
    // against that transient state would reset a valid, stationary dwell on
    // every unrelated transaction. Only settled notifies (suppressionDepth
    // back at 0) reflect a state a dwell target should be judged against.
    const revalidate = (): void => {
      if (getTabCommandLedger().suppressionDepth > 0) return;
      edgeDwell.revalidate();
    };
    const unsubscribeTabs = useTabsStore.subscribe(revalidate);
    const unsubscribeLocks = subscribeTabStructuralLocks(revalidate);
    const unsubscribeLedger = subscribeToTabCommandLedger(revalidate);
    const unsubscribeCompatibility = subscribeTabSplitCompatibility(revalidate);
    return () => {
      unsubscribeTabs();
      unsubscribeLocks();
      unsubscribeLedger();
      unsubscribeCompatibility();
    };
  }, [edgeDwell]);
  const sensors = useSensors(
    useSensor(EpicCanvasPointerSensor, {
      activationConstraint: {
        distance: EPIC_CANVAS_DRAG_ACTIVATION_DISTANCE,
      },
    }),
  );

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      lastResolvedDropRef.current = null;
      lastReparentDropRef.current = null;
      clearSpringLoad(springLoadRef);
      edgeDwell.reset();
      const dndStore = useEpicDndStore.getState();
      const source = readActiveDragSource(event.active);
      if (source !== null) {
        dndStore.canvasDragStarted(source, resolveOverlayTileForSource(source));
        if (source.kind === ARTIFACT_TAB_DND_TYPE && source.isPreview) {
          useEpicCanvasStore
            .getState()
            .promotePreviewInTab(source.viewTabId, source.sourceGroupId);
        }
        return;
      }
      const headerTab = readHeaderTabDragData(event.active.data.current);
      if (headerTab !== null) {
        dndStore.headerTabDragStarted(headerTab);
      }
    },
    [edgeDwell],
  );

  const updateDropPreview = useCallback(
    (event: DragUpdateEvent) => {
      // SINGLE pointer source of truth: the point stashed by the collision
      // pass that produced `event.over`. Never reconstruct it from
      // `activatorEvent` + `event.delta` (scroll-adjusted; diverges under
      // autoScroll).
      const point = getLastCollisionPointerPoint();
      const source = readActiveDragSource(event.active);
      if (source !== null) {
        updateCanvasSourcePreview(source, event, point, reparentRefs);
        return;
      }
      const headerTab = readHeaderTabDragData(event.active.data.current);
      if (headerTab !== null) {
        updateHeaderTabSourcePreview(headerTab, event, point, edgeDwell);
      }
    },
    [edgeDwell, reparentRefs],
  );

  const handleDragMove = useCallback(
    (event: DragMoveEvent) => {
      updateDropPreview(event);
    },
    [updateDropPreview],
  );

  const handleDragOver = useCallback(
    (event: DragOverEvent) => {
      updateDropPreview(event);
    },
    [updateDropPreview],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      // Pointer-up can race the final collision update: refresh the resolved
      // drop from the end event before committing, mirroring the previous
      // controller's last-resolved-ref behavior.
      updateDropPreview(event);
      clearSpringLoad(springLoadRef);
      // A sidebar-row/panel reparent wins over the canvas/header commit:
      // commit it (with the canReparent re-check inside) and skip the rest.
      const reparent = lastReparentDropRef.current;
      if (reparent !== null) {
        commitSidebarReparentDrop({
          epicId: reparent.epicId,
          sourceNodeId: reparent.sourceNodeId,
          newParentId: reparent.newParentId,
          panelId: reparent.panelId,
          viewTabId: reparent.viewTabId,
        });
        lastResolvedDropRef.current = null;
        lastReparentDropRef.current = null;
        clearLastCollisionPointerPoint();
        useEpicDndStore.getState().dragEnded();
        return;
      }
      const headerStripIndex = useEpicDndStore.getState().headerStripDropIndex;
      const source = readActiveDragSource(event.active);
      if (source !== null) {
        if (headerStripIndex !== null && canDropOnHeaderStrip(source)) {
          const result = commitHeaderStripDrop(source, headerStripIndex);
          if (result !== null) {
            navigateToTabIntent(
              navigate,
              existingEpicTabIntent({
                epicId: result.epicId,
                tabId: result.tabId,
                focus: undefined,
              }),
              undefined,
            );
          }
        } else {
          const drop = lastResolvedDropRef.current;
          if (drop !== null) {
            commitResolvedCanvasDrop(drop, navigateNested);
          }
        }
      } else {
        commitHeaderTabDrop({
          event,
          headerStripIndex,
          navigate,
          edgeDwell,
        });
      }
      edgeDwell.reset();
      lastResolvedDropRef.current = null;
      lastReparentDropRef.current = null;
      clearLastCollisionPointerPoint();
      useEpicDndStore.getState().dragEnded();
    },
    [edgeDwell, navigate, navigateNested, updateDropPreview],
  );

  const handleDragCancel = useCallback(() => {
    lastResolvedDropRef.current = null;
    lastReparentDropRef.current = null;
    clearSpringLoad(springLoadRef);
    edgeDwell.reset();
    clearLastCollisionPointerPoint();
    useEpicDndStore.getState().dragEnded();
  }, [edgeDwell]);

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={epicRootCollisionDetection}
      autoScroll={{ threshold: { x: 0.2, y: 0.2 } }}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {props.children}
      <DragOverlay
        dropAnimation={null}
        modifiers={[snapChatArtifactChipToCursor]}
      >
        <EpicRootDragOverlayContent />
      </DragOverlay>
    </DndContext>
  );
}
