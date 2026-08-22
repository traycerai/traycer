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
  SIDEBAR_NODE_DND_TYPE,
  readComposerAttachmentDropTargetData,
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
  type HeaderStripDropResult,
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
  isHeaderStripPairZone,
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
  TOP_LEVEL_EDGE_SPLIT_TARGET,
  TOP_LEVEL_STRIP_PAIR_TARGET,
  readTopLevelTabDropTarget,
  resolveValidatedTopLevelTabDrop,
  stripPairTargetForIndex,
  type TopLevelDwellTarget,
  type TopLevelEdgeSplitTarget,
  type TopLevelFillableTarget,
  type TopLevelStripPairTarget,
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
} from "@dnd-kit/core";
import { snapCenterToCursor } from "@dnd-kit/modifiers";
import { useNavigate, type UseNavigateResult } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

/** Keep every root drag preview centered beneath pointer-based activators. */
const ROOT_DRAG_OVERLAY_MODIFIERS = [snapCenterToCursor];

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
  const headerSlot =
    over === null ? null : readHeaderTabSlotDropData(over.data.current);
  if (headerSlot === null || point === null) {
    edgeDwell.reset();
    dndStore.headerStripDropIndexChanged(null);
    return;
  }
  const slotRect = readOverRect(event);
  const reorderIndex = resolveHeaderStripDropIndex({
    slot: headerSlot,
    pointerX: point.x,
    slotRect,
    sourceIndex: headerTab.index,
  });
  const pairTarget = isHeaderStripPairZone({
    slot: headerSlot,
    pointerX: point.x,
    slotRect,
  })
    ? stripPairTargetForIndex(headerSlot.index, layoutFromTabsStore())
    : null;
  if (
    pairTarget === null ||
    resolveLiveTopLevelDrop(headerTab, pairTarget) === null
  ) {
    edgeDwell.reset();
    dndStore.headerStripDropIndexChanged(reorderIndex);
    return;
  }
  edgeDwell.setTargetValidator(
    (candidate) => resolveLiveTopLevelDrop(headerTab, candidate) !== null,
  );
  edgeDwell.observe(pairTarget);
  // The pair only takes over once the dwell actually fires. Until then the
  // reorder indicator stays up, so crossing a tab's middle en route to a
  // reorder never leaves the strip with no visible destination.
  dndStore.headerStripDropIndexChanged(
    edgeDwell.getState().kind === "preview" ? null : reorderIndex,
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
  target: TopLevelDwellTarget | TopLevelFillableTarget,
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
    fillTopLevelSlot(validDrop.source, validDrop.target, activate);
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
  // A fired pair dwell wins over the reorder it was hovering: the strip slot is
  // the droppable under the pointer in both cases, so the dwell state is what
  // distinguishes "combine with this tab" from "move next to it".
  const dwell = input.edgeDwell.getState();
  if (
    headerTab !== null &&
    dwell.kind === "preview" &&
    dwell.target.kind === TOP_LEVEL_STRIP_PAIR_TARGET
  ) {
    commitHeaderStripPair(
      headerTab,
      dwell.target,
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

/**
 * Dropping A onto B yields `B | A`: the tab that stayed put keeps the left
 * side, the dragged one lands where it was released and takes focus.
 */
function commitHeaderStripPair(
  headerTab: HeaderTabDragData,
  target: TopLevelStripPairTarget,
  edgeDwell: EdgeSplitDwellMachine,
  navigate: UseNavigateResult<string>,
): void {
  const validDrop = resolveLiveTopLevelDrop(headerTab, target);
  if (validDrop === null) {
    edgeDwell.reset();
    return;
  }
  if (edgeDwell.commit(target) === null) return;
  const sourceRef = validDrop.source;
  const sourceTab = getHeaderTabs().find(
    (tab) => tab.kind === sourceRef.kind && tab.id === sourceRef.id,
  );
  if (sourceTab === undefined) return;
  activatePreparedPairTabIntent(
    navigate,
    {
      left: target.targetRef,
      right: sourceRef,
      focusedRef: sourceRef,
      splitId: `split:${uuidv4()}`,
      leftRatio: 0.5,
    },
    tabResolveIntent(sourceTab),
    undefined,
  );
}

function commitHeaderEdgeSplit(
  sourceRef: TabRef,
  target: TopLevelEdgeSplitTarget,
  edgeDwell: EdgeSplitDwellMachine,
  navigate: UseNavigateResult<string>,
): void {
  // `commit` only succeeds for a target equal to this one (same kind, ref and
  // side), so the already-narrowed `target` describes the committed geometry.
  if (edgeDwell.commit(target) === null) {
    return;
  }
  const sourceTab = getHeaderTabs().find(
    (tab) => tab.kind === sourceRef.kind && tab.id === sourceRef.id,
  );
  if (sourceTab === undefined) return;
  activatePreparedPairTabIntent(
    navigate,
    {
      left: target.side === "left" ? sourceRef : target.targetRef,
      right: target.side === "right" ? sourceRef : target.targetRef,
      focusedRef: sourceRef,
      splitId: `split:${uuidv4()}`,
      leftRatio: 0.5,
    },
    tabResolveIntent(sourceTab),
    undefined,
  );
}

/**
 * Canvas tear-off onto the header strip. Source creation and authoritative
 * placement run inside ONE suppressed coordinator transaction: the source
 * store's synchronous reconciliation subscriber fires between them otherwise,
 * and with a stale legacy `stripOrder` it would rebuild the flat layout and
 * dissolve existing split groups before placement. Returns the committed drop
 * only when the new ref was also placed.
 */
function commitHeaderStripDropAtIndex(
  source: EpicCanvasDragSourceData,
  headerStripIndex: number,
): HeaderStripDropResult | null {
  let dropped: HeaderStripDropResult | null = null;
  const placedRef = tabCommandCoordinator.createSourceRefAtStripIndex(
    headerStripIndex,
    () => {
      dropped = commitHeaderStripDrop(source, headerStripIndex);
      return dropped === null ? null : { kind: "epic", id: dropped.tabId };
    },
  );
  return placedRef === null ? null : dropped;
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
        const store = useEpicDndStore.getState();
        const target = state.kind === "preview" ? state.target : null;
        const pairTarget =
          target?.kind === TOP_LEVEL_STRIP_PAIR_TARGET ? target : null;
        store.topLevelEdgeSplitPreviewChanged(
          target?.kind === TOP_LEVEL_EDGE_SPLIT_TARGET ? target : null,
        );
        store.topLevelStripPairPreviewChanged(pairTarget?.targetRef ?? null);
        // A fired pair preview owns the strip: drop the reorder line that was
        // still showing while the dwell was merely armed.
        if (pairTarget !== null) store.headerStripDropIndexChanged(null);
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

  // Handed to the imperative reparent commit so an RPC-routed move can
  // invalidate the moved node's record query on success - this provider is
  // the nearest hook context to that commit.
  const queryClient = useQueryClient();
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
          queryClient,
        });
        lastResolvedDropRef.current = null;
        lastReparentDropRef.current = null;
        clearLastCollisionPointerPoint();
        useEpicDndStore.getState().dragEnded();
        return;
      }
      const source = readActiveDragSource(event.active);
      const composerTarget = readComposerAttachmentDropTargetData(
        event.over?.data.current,
      );
      if (
        source !== null &&
        composerTarget !== null &&
        composerTarget.accepts(source)
      ) {
        composerTarget.attach(source);
        edgeDwell.reset();
        lastResolvedDropRef.current = null;
        lastReparentDropRef.current = null;
        clearLastCollisionPointerPoint();
        useEpicDndStore.getState().dragEnded();
        return;
      }
      const headerStripIndex = useEpicDndStore.getState().headerStripDropIndex;
      if (source !== null) {
        if (headerStripIndex !== null && canDropOnHeaderStrip(source)) {
          const result = commitHeaderStripDropAtIndex(source, headerStripIndex);
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
    [edgeDwell, navigate, navigateNested, queryClient, updateDropPreview],
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
      <DragOverlay dropAnimation={null} modifiers={ROOT_DRAG_OVERLAY_MODIFIERS}>
        <EpicRootDragOverlayContent />
      </DragOverlay>
    </DndContext>
  );
}
