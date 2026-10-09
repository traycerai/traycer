import {
  Fragment,
  use,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  useDraggable,
  useDroppable,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import { HoverCard, HoverCardGroup } from "@/components/ui/hover-card";
import { Button } from "@/components/ui/button";
import { useLayoutRegion } from "@/components/layout-editor/use-layout-region";
import { LAYOUT_CLUSTER_ATTRIBUTE } from "@/components/layout-editor/canvas/canvas-attributes";
import {
  leftPanelIdForRailRegion,
  railDisplayEntries,
  railRegionForLeftPanelId,
  type RailEntry,
} from "@/lib/layout/rail";
import {
  railStackJoin,
  type EdgeSide,
  type RailStackJoin,
} from "@/lib/layout/layout-arrangement";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { RailContextMenuContent } from "@/components/epic-canvas/sidebar/rail-context-menu-content";
import { DropLine } from "@/components/ui/drop-line";
import { LeftPanelRailDivider } from "@/components/epic-canvas/sidebar/left-panel-rail-divider";
import { LeftPanelRailStack } from "@/components/epic-canvas/sidebar/left-panel-rail-stack";
import { LeftPanelRailIcon } from "@/components/epic-canvas/sidebar/left-panel-rail-icon";
import { useRailDividersEditing } from "@/components/epic-canvas/sidebar/use-rail-dividers-editing";
import {
  getLeftPanelRailDragId,
  getLeftPanelRailDropId,
  getLeftPanelRailListDropId,
  getPaneScopedDndId,
  LEFT_PANEL_RAIL_ITEM_DND_TYPE,
  railDragCarry,
  type EpicCanvasDropTargetData,
  type EpicCanvasLeftPanelRailDragData,
  type LeftPanelRailDropPosition,
} from "@/components/epic-canvas/dnd/dnd";
import { useDragSourceDisabled } from "@/components/epic-canvas/dnd/use-drag-source-disabled";
import {
  useEpicDndInteractionLocked,
  useLeftPanelRailDragSource,
  useLeftPanelRailDropPreview,
  useLeftPanelSectionDragSource,
} from "@/components/epic-canvas/dnd/dnd-store";
import { mergeRefs } from "@/lib/merge-refs";
import { cn } from "@/lib/utils";
import {
  useLayoutRail,
  usePanelVisibilityOverrides,
} from "@/lib/layout/rail-view";
import {
  useActiveLeftPanelId,
  useCommentsPanelRevealed,
  useEpicLeftPanelStore,
  useMainPanelCollapsed,
} from "@/stores/epics/left-panel-store";
import { type LeftPanelId } from "@/lib/left-panel-ids";
import { useActiveEpicArtifactId } from "@/stores/epics/canvas/store";
import {
  getLeftPanelDefinition,
  isLeftPanelVisible,
  resolveDisplayedPanelId,
  retainDisplayedPrPanel,
  type LeftPanelAvailabilityContext,
  type LeftPanelMetadataDefinition,
} from "@/components/epic-canvas/sidebar/left-panel-registry";
import {
  LEFT_PANEL_RAIL_COMBINE_TARGET_CLASS,
  LEFT_PANEL_RAIL_TAB_UNDERLINE_CLASS,
  LEFT_PANEL_RAIL_TILE_CLASS,
  railGroupLabel,
} from "@/components/epic-canvas/sidebar/left-panel-rail-tile";
import { useEpicArtifact } from "@/lib/epic-selectors";
import {
  ColumnEdgeContext,
  useColumnOverlayPlacement,
} from "@/components/layout/column-edge-context";
import { useSurfaceHostPinWithDefault } from "@/hooks/host/use-surface-host-pin";
import { tabSurfaceKey } from "@/stores/host/surface-host-selection-store";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import {
  selectPrScopeHasItems,
  usePrPresenceStore,
} from "@/stores/epics/pr-presence-store";
import { useSidebarRailWidthStore } from "@/stores/epics/sidebar-rail-width-store";

export type RailOrientation = "vertical" | "horizontal";

interface EpicLeftPanelRailProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly orientation: RailOrientation;
}

interface EpicLeftPanelStaticRailProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly orientation: RailOrientation;
}

interface EpicLeftPanelRailContentProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly orientation: RailOrientation;
  readonly hasActiveCommentableArtifact: boolean;
}

/**
 * One thing the rail draws: a panel's icon, a stack's ONE group icon (G3,
 * L-181), or a divider (L-155).
 *
 * At rest a divider is extra space and in a session a handle (L-140), which is
 * `LeftPanelRailDivider`'s answer rather than this list's. Which panels are
 * drawn, which pairs survive as pairs, and which dividers still separate two
 * drawn icons at rest (T3) is `railDisplayEntries`' answer, not a second copy
 * of the rule here (R5R-05, L-166) - so a hidden member leaves its stack on
 * the rail and in the body by the same walk.
 */
type RailItem =
  | { readonly kind: "panel"; readonly panel: LeftPanelMetadataDefinition }
  | {
      readonly kind: "stack";
      readonly id: string;
      readonly members: ReadonlyArray<LeftPanelMetadataDefinition>;
    }
  | { readonly kind: "divider"; readonly id: string };

function railItems(
  rail: ReadonlyArray<RailEntry>,
  context: LeftPanelAvailabilityContext,
  dividersEditing: boolean,
): ReadonlyArray<RailItem> {
  return railDisplayEntries(
    rail,
    (regionId) =>
      isLeftPanelVisible(
        getLeftPanelDefinition(leftPanelIdForRailRegion(regionId)),
        context,
      ),
    dividersEditing ? "handles" : "spacing",
  ).map((entry): RailItem => {
    if (entry.kind === "divider") return { kind: "divider", id: entry.id };
    if (entry.kind === "panel") {
      return {
        kind: "panel",
        panel: getLeftPanelDefinition(leftPanelIdForRailRegion(entry.id)),
      };
    }
    return {
      kind: "stack",
      id: entry.id,
      members: entry.members.map((member) =>
        getLeftPanelDefinition(leftPanelIdForRailRegion(member)),
      ),
    };
  });
}

/** Every panel a rail item draws, so the highlight walks one list. */
function railItemPanels(
  items: ReadonlyArray<RailItem>,
): ReadonlyArray<LeftPanelMetadataDefinition> {
  return items.flatMap((item): LeftPanelMetadataDefinition[] => {
    if (item.kind === "divider") return [];
    return item.kind === "panel" ? [item.panel] : [...item.members];
  });
}

/**
 * VS Code-style mini rail. Always visible (~3rem wide). Clicking an inactive
 * icon switches the active panel and expands the main panel if collapsed.
 * Clicking the already-active icon toggles main panel collapse. Dragging an
 * icon before or after another reorders the rail (L-155), and onto another's
 * middle adds it to that icon's stack (L-168, L-181); a stack's icon carries
 * its whole stack.
 */
export function EpicLeftPanelRail(props: EpicLeftPanelRailProps) {
  const { epicId, tabId, orientation } = props;
  const activeArtifactId = useActiveEpicArtifactId(tabId);
  const activeArtifact = useEpicArtifact(activeArtifactId);
  const hasActiveCommentableArtifact =
    activeArtifact !== null && "kind" in activeArtifact;

  return (
    <EpicLeftPanelRailContent
      epicId={epicId}
      tabId={tabId}
      orientation={orientation}
      hasActiveCommentableArtifact={hasActiveCommentableArtifact}
    />
  );
}

export function EpicLeftPanelStaticRail(props: EpicLeftPanelStaticRailProps) {
  return (
    <EpicLeftPanelRailContent
      epicId={props.epicId}
      tabId={props.tabId}
      orientation={props.orientation}
      hasActiveCommentableArtifact={false}
    />
  );
}

function EpicLeftPanelRailContent(props: EpicLeftPanelRailContentProps) {
  const { epicId, tabId, orientation, hasActiveCommentableArtifact } = props;
  const activePanelId = useActiveLeftPanelId(tabId);
  const collapsed = useMainPanelCollapsed(tabId);
  const rail = useLayoutRail();
  // Asked once for the whole rail (L-109): the dividers below are grab handles
  // only while this rail is the one being customized, and plain space otherwise.
  const dividersEditing = useRailDividersEditing();
  const commentsPanelRevealed = useCommentsPanelRevealed(tabId);
  // The host the PR panel records presence under (see `EpicLeftPanelHost`).
  const canvasHostId = useCanvasHostId();
  const { resolvedHostId: hostId } = useSurfaceHostPinWithDefault(
    tabSurfaceKey("pull-requests", tabId),
    canvasHostId,
  );
  const hasPullRequests = usePrPresenceStore(
    selectPrScopeHasItems(hostId, epicId),
  );
  const visibilityOverrideById = usePanelVisibilityOverrides();
  const setActivePanelIdAndExpand = useEpicLeftPanelStore(
    (s) => s.setActivePanelIdAndExpand,
  );
  const toggleMainCollapsed = useEpicLeftPanelStore(
    (s) => s.toggleMainCollapsed,
  );
  const collapsedById = useEpicLeftPanelStore(
    (s) => s.panelSectionCollapsedByPanelId,
  );
  const availabilityContext = useMemo<LeftPanelAvailabilityContext>(
    () =>
      retainDisplayedPrPanel(rail, activePanelId, {
        commentsPanelRevealed,
        hasActiveCommentableArtifact,
        hasPullRequests,
        visibilityOverrideById,
      }),
    [
      rail,
      activePanelId,
      commentsPanelRevealed,
      hasActiveCommentableArtifact,
      hasPullRequests,
      visibilityOverrideById,
    ],
  );
  const items = useMemo(
    () => railItems(rail, availabilityContext, dividersEditing),
    [availabilityContext, rail, dividersEditing],
  );
  // Which icon lights up. Resolved rather than compared against `activePanelId`
  // directly so a hidden active panel highlights whatever the body fell back
  // to, instead of leaving the rail with nothing marked.
  const displayedPanelId = resolveDisplayedPanelId(
    railItemPanels(items).map((panel) => panel.id),
    activePanelId,
  );
  // The icon the pointer was over when the menu opened, or null for empty rail
  // space. Set on the button's own contextmenu after the rail's capture-phase
  // reset, so both land in the same render as Radix opening the menu.
  const [contextPanelId, setContextPanelId] = useState<LeftPanelId | null>(
    null,
  );
  const handleRailContextMenuCapture = useCallback((): void => {
    setContextPanelId(null);
  }, []);
  const railListDropData = useMemo<EpicCanvasDropTargetData>(
    () => ({ kind: "left-panel-rail-list", viewTabId: tabId }),
    [tabId],
  );
  const { setNodeRef: railDropRef } = useDroppable({
    id: getPaneScopedDndId(tabId, getLeftPanelRailListDropId(epicId)),
    data: railListDropData,
  });
  // The horizontal rail's own unclamped content width (bug #1): every icon
  // and divider is `shrink-0`, so the run from the first to the last of them,
  // plus the rail's padding, is the room this tab's rail actually needs
  // regardless of how wide or narrow the sidebar currently is. Not
  // `scrollWidth`: the rail is `w-full`, and a scroller's `scrollWidth` never
  // reads below its own width, so a rail measured at 500px made 500px the
  // sidebar's minimum.
  // Reported into the shared store so the sidebar's one global width never
  // clips whichever tab is on screen (`sidebar-rail-width-store.ts`). Not a
  // concern for the collapsed vertical rail, which is a fixed `w-12` outside
  // the resizable panel entirely.
  const horizontalRailRef = useRef<HTMLDivElement | null>(null);
  const setRailNaturalWidthPx = useSidebarRailWidthStore(
    (s) => s.setRailNaturalWidthPx,
  );
  const clearRailNaturalWidthPx = useSidebarRailWidthStore(
    (s) => s.clearRailNaturalWidthPx,
  );
  useLayoutEffect(() => {
    if (orientation !== "horizontal") return;
    const element = horizontalRailRef.current;
    if (element === null) return;
    setRailNaturalWidthPx(tabId, railContentWidthPx(element));
  }, [orientation, items, dividersEditing, tabId, setRailNaturalWidthPx]);
  useLayoutEffect(() => {
    if (orientation !== "horizontal") return;
    return () => clearRailNaturalWidthPx(tabId);
  }, [orientation, tabId, clearRailNaturalWidthPx]);
  const setRailRootRef = useMemo(
    () => mergeRefs<HTMLDivElement>(railDropRef, horizontalRailRef),
    [railDropRef],
  );
  // Narrow selector hooks: a rail drag preview tick re-renders ONLY the rail,
  // and a canvas-source preview tick (pane bodies / strips) never reaches it.
  const railPanelDropPreview = useLeftPanelRailDropPreview(tabId);
  const panelSectionDragSource = useLeftPanelSectionDragSource(tabId);
  const panelSectionDropDefinition =
    panelSectionDragSource === null
      ? null
      : getLeftPanelDefinition(panelSectionDragSource.panelId);
  const dropAtRailEnd = railPanelDropPreview?.kind === "left-panel-rail-list";
  // What this tab's rail drag carries, whatever it was grabbed off, so a
  // middle-band preview can be read as a join or nothing (L-181).
  const dragSource = useLeftPanelRailDragSource(tabId);
  const dropCueFor = (
    targetPanelId: LeftPanelId,
  ): Exclude<RailStackJoin, "same"> | null => {
    if (dragSource === null || previewPositionFor(targetPanelId) !== "combine")
      return null;
    const join = railStackJoin(
      rail,
      dragSource.panelId,
      targetPanelId,
      railDragCarry(dragSource),
    );
    return join === "same" ? null : join;
  };
  // The band the drop is in, for whichever icon it is over. `combine` lights
  // the icon itself, because the panel being carried is going INTO it (L-168);
  // `before` and `after` draw a boundary slot beside it, because it is going
  // next to it. The icon used to light on `isOver` alone, which said "into
  // this one" for all three.
  const previewPositionFor = (
    panelId: LeftPanelId,
  ): LeftPanelRailDropPosition | null =>
    railPanelDropPreview?.kind === "left-panel-rail" &&
    railPanelDropPreview.panelId === panelId
      ? railPanelDropPreview.position
      : null;

  // Compared against the icon that is LIT, not against `activePanelId`
  // (R5R-09): when the active panel is hidden the rail lights the fallback,
  // and clicking the lit icon has to collapse the column the way clicking a
  // lit icon always does rather than silently re-selecting it.
  const handleClick = useCallback(
    (panelId: LeftPanelId) => {
      if (panelId === displayedPanelId) {
        toggleMainCollapsed(tabId);
        return;
      }
      setActivePanelIdAndExpand(tabId, panelId);
    },
    [displayedPanelId, setActivePanelIdAndExpand, tabId, toggleMainCollapsed],
  );

  // A stack's icon (G3) is lit while any member is the displayed panel, and
  // then it collapses the column like any lit icon (VS Code's rule), leaving
  // each section as the user set it. It used to re-open a collapsed member
  // first, one per click, keyed on which member was "active" - which a stack,
  // drawing every member at once, never shows. Opening the stack lands on a
  // member that is already open, so it changes no section either.
  const handleGroupClick = useCallback(
    (members: ReadonlyArray<LeftPanelId>) => {
      if (members.some((member) => member === displayedPanelId)) {
        toggleMainCollapsed(tabId);
        return;
      }
      setActivePanelIdAndExpand(
        tabId,
        members.find((member) => collapsedById[member] !== true) ?? members[0],
      );
    },
    [
      collapsedById,
      displayedPanelId,
      setActivePanelIdAndExpand,
      tabId,
      toggleMainCollapsed,
    ],
  );

  return (
    // One clock for the rail's labels: the first waits, the neighbour's
    // replaces it at once.
    <HoverCardGroup>
      {/*
        One context menu for the WHOLE rail rather than one per icon. Right-
        clicking an icon opens it, and so does right-clicking the empty rail -
        which is the only way back to a panel the user hid, once there is no
        icon left to aim at. Nesting a second trigger on the button would fire
        both menus for the same event; the button reports which panel was under
        the pointer through `contextPanelId` instead.
      */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={setRailRootRef}
            onContextMenuCapture={handleRailContextMenuCapture}
            role="toolbar"
            aria-label="Epic left panels"
            aria-orientation={orientation}
            data-epic-sidebar-rail
            data-testid="epic-sidebar-rail"
            data-orientation={orientation}
            {...{ [LAYOUT_CLUSTER_ATTRIBUTE]: "" }}
            className={cn(
              "relative flex items-center gap-1 bg-background",
              orientation === "vertical" &&
                "h-full w-12 shrink-0 flex-col justify-start overflow-y-auto py-2",
              // Safe centring: a rail wider than the panel (a task with
              // pull requests at the default width) starts at its first
              // icon rather than clipping it out of scroll reach.
              orientation === "horizontal" &&
                "h-10 w-full min-w-0 flex-row justify-center-safe overflow-x-auto px-2",
            )}
          >
            {items.map((item) => {
              if (item.kind === "divider") {
                return (
                  <LeftPanelRailDivider
                    key={item.id}
                    dividerId={item.id}
                    orientation={orientation}
                    editing={dividersEditing}
                  />
                );
              }
              if (item.kind === "stack") {
                // One icon for the stack (G3, L-181): the top panel's, named
                // for every member, and the whole stack moves when it is
                // dragged. Previews and the join cue read off the top, which
                // is the drop target.
                const members = item.members.map((member) => member.id);
                const top = item.members[0];
                const previewPosition = previewPositionFor(top.id);
                return (
                  <Fragment key={item.id}>
                    {previewPosition === "before" ? (
                      <RailBoundaryPreview
                        definition={panelSectionDropDefinition}
                        orientation={orientation}
                      />
                    ) : null}
                    <LeftPanelRailStack
                      stackId={item.id}
                      memberCount={members.length}
                      showCount={dividersEditing}
                    >
                      <RailPanelButton
                        tabId={tabId}
                        panel={top}
                        label={railGroupLabel(
                          item.members.map((member) => member.title),
                        )}
                        orientation={orientation}
                        active={
                          members.some((id) => id === displayedPanelId) &&
                          !collapsed
                        }
                        dropCue={dropCueFor(top.id)}
                        onClick={() => handleGroupClick(members)}
                        onContextMenu={setContextPanelId}
                      />
                    </LeftPanelRailStack>
                    {previewPosition === "after" ? (
                      <RailBoundaryPreview
                        definition={panelSectionDropDefinition}
                        orientation={orientation}
                      />
                    ) : null}
                  </Fragment>
                );
              }
              const panelId = item.panel.id;
              const previewPosition = previewPositionFor(panelId);
              return (
                <Fragment key={panelId}>
                  {previewPosition === "before" ? (
                    <RailBoundaryPreview
                      definition={panelSectionDropDefinition}
                      orientation={orientation}
                    />
                  ) : null}
                  <RailPanelButton
                    tabId={tabId}
                    panel={item.panel}
                    label={item.panel.title}
                    orientation={orientation}
                    active={panelId === displayedPanelId && !collapsed}
                    dropCue={dropCueFor(panelId)}
                    onClick={() => handleClick(panelId)}
                    onContextMenu={setContextPanelId}
                  />
                  {previewPosition === "after" ? (
                    <RailBoundaryPreview
                      definition={panelSectionDropDefinition}
                      orientation={orientation}
                    />
                  ) : null}
                </Fragment>
              );
            })}
            {dropAtRailEnd ? (
              <RailBoundaryPreview
                definition={panelSectionDropDefinition}
                orientation={orientation}
              />
            ) : null}
          </div>
        </ContextMenuTrigger>
        <RailContextMenuContent
          context={availabilityContext}
          contextPanelId={contextPanelId}
        />
      </ContextMenu>
    </HoverCardGroup>
  );
}

function railContentWidthPx(rail: HTMLElement): number {
  const style = getComputedStyle(rail);
  const padding =
    Number.parseFloat(style.paddingLeft) +
    Number.parseFloat(style.paddingRight);
  let left = Infinity;
  let right = -Infinity;
  for (const child of rail.children) {
    const rect = child.getBoundingClientRect();
    // A `display: contents` wrapper has no box of its own.
    if (rect.width === 0) continue;
    left = Math.min(left, rect.left);
    right = Math.max(right, rect.right);
  }
  return right > left ? right - left + padding : padding;
}

function RailBoundaryPreview(props: {
  readonly definition: LeftPanelMetadataDefinition | null;
  readonly orientation: RailOrientation;
}) {
  if (props.definition !== null) {
    return (
      <RailPanelDropSlot
        definition={props.definition}
        orientation={props.orientation}
        active
      />
    );
  }
  return <RailPanelDropLine orientation={props.orientation} />;
}

function RailPanelDropSlot(props: {
  readonly definition: LeftPanelMetadataDefinition;
  readonly orientation: RailOrientation;
  readonly active: boolean;
}) {
  const Icon = props.definition.icon;
  return (
    <div
      aria-hidden
      data-testid="epic-rail-panel-drop-slot"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md border border-dashed border-border/80 text-muted-foreground/70 transition-colors",
        props.orientation === "vertical" ? "my-1 size-9" : "mx-1 size-8",
        props.active && "border-primary/70 bg-primary/10 text-foreground",
      )}
    >
      <Icon className="size-4" />
    </div>
  );
}

function RailPanelDropLine(props: { readonly orientation: RailOrientation }) {
  return (
    <DropLine
      orientation={props.orientation === "vertical" ? "horizontal" : "vertical"}
      glow
      className={cn(
        "shrink-0",
        props.orientation === "vertical" && "my-1 w-8",
        props.orientation === "horizontal" && "mx-1 h-8",
      )}
      testId="epic-rail-panel-drop-line"
    />
  );
}

interface RailPanelButtonProps {
  readonly tabId: string;
  readonly panel: LeftPanelMetadataDefinition;
  /** The tooltip and accessible name: the panel's title, or a group's (G3). */
  readonly label: string;
  readonly orientation: RailOrientation;
  readonly active: boolean;
  /**
   * What a drop aimed at this icon's MIDDLE band would do (L-181): join its
   * stack, or nothing.
   */
  readonly dropCue: Exclude<RailStackJoin, "same"> | null;
  readonly onClick: () => void;
  /** Reports the panel under the pointer to the rail-wide context menu. */
  readonly onContextMenu: (panelId: LeftPanelId) => void;
}

function RailPanelButton(props: RailPanelButtonProps) {
  const {
    tabId,
    panel,
    label,
    orientation,
    active,
    dropCue,
    onClick,
    onContextMenu,
  } = props;
  const handleContextMenu = useCallback((): void => {
    onContextMenu(panel.id);
  }, [onContextMenu, panel.id]);
  const { ref: hotspotRef } = useLayoutRegion({
    regionId: railRegionForLeftPanelId(panel.id),
    instanceId: null,
  });
  const dragData = useMemo<EpicCanvasLeftPanelRailDragData>(
    () => ({
      kind: LEFT_PANEL_RAIL_ITEM_DND_TYPE,
      viewTabId: tabId,
      panelId: panel.id,
      origin: "rail",
    }),
    [panel.id, tabId],
  );
  const dragDisabled = useDragSourceDisabled();
  const {
    listeners,
    setNodeRef: dragRef,
    isDragging,
  } = useDraggable({
    id: getPaneScopedDndId(tabId, getLeftPanelRailDragId(panel.id)),
    data: dragData,
    disabled: dragDisabled,
  });
  const dropData = useMemo<EpicCanvasDropTargetData>(
    () => ({
      kind: "left-panel-rail-item",
      viewTabId: tabId,
      panelId: panel.id,
      orientation,
    }),
    [orientation, panel.id, tabId],
  );
  const { setNodeRef: dropRef } = useDroppable({
    id: getPaneScopedDndId(tabId, getLeftPanelRailDropId(panel.id)),
    data: dropData,
  });
  const setButtonRef = useMemo(
    () => mergeRefs<HTMLElement>(dragRef, dropRef, hotspotRef),
    [dragRef, dropRef, hotspotRef],
  );

  return (
    <RailButton
      buttonRef={setButtonRef}
      handleListeners={listeners}
      panelId={panel.id}
      label={label}
      orientation={orientation}
      active={active}
      isDragSource={isDragging}
      dropCue={dropCue}
      testId={`epic-rail-${panel.id}`}
      onClick={onClick}
      onContextMenu={handleContextMenu}
    />
  );
}

export interface RailButtonProps {
  readonly buttonRef: (element: HTMLElement | null) => void;
  readonly handleListeners: DraggableSyntheticListeners;
  readonly panelId: LeftPanelId;
  readonly label: string;
  readonly orientation: RailOrientation;
  readonly active: boolean;
  readonly isDragSource: boolean;
  readonly dropCue: Exclude<RailStackJoin, "same"> | null;
  readonly testId: string;
  readonly onClick: () => void;
  readonly onContextMenu: () => void;
}

/** The vertical rail's active bar, on the edge that faces the window's side. */
const RAIL_ACTIVE_INDICATOR_CLASS: Readonly<Record<EdgeSide, string>> = {
  left: "absolute inset-y-1 left-0 rounded-l-none rounded-r",
  right: "absolute inset-y-1 right-0 rounded-r-none rounded-l",
};

/**
 * One rail tile, presentational: the live rail wires it to dnd and the panel
 * store, and the sample workspace's sidebar draws the same tile (F3).
 */
export function RailButton(props: RailButtonProps) {
  const {
    buttonRef,
    handleListeners,
    panelId,
    label,
    orientation,
    active,
    isDragSource,
    dropCue,
    testId,
    onClick,
    onContextMenu,
  } = props;
  const sidebarSide = use(ColumnEdgeContext) ?? "left";
  const placement = useColumnOverlayPlacement("row");
  // No labels mid-drag: a neighbour's label popping under the pointer covers
  // the drop line and the combine highlight the user is reading.
  const dragInFlight = useEpicDndInteractionLocked();
  const activeClass =
    orientation === "vertical"
      ? "bg-accent text-accent-foreground hover:bg-accent"
      : "text-foreground hover:bg-transparent";
  const activeIndicatorClass =
    orientation === "vertical"
      ? RAIL_ACTIVE_INDICATOR_CLASS[sidebarSide]
      : LEFT_PANEL_RAIL_TAB_UNDERLINE_CLASS;
  return (
    <HoverCard
      content={label}
      appearance="tooltip"
      semantics={{ role: "tooltip" }}
      side={
        orientation === "vertical" ? (placement?.side ?? "right") : "bottom"
      }
      align={
        orientation === "vertical" ? (placement?.align ?? "center") : "center"
      }
      sideOffset={4}
      enabled={!dragInFlight}
      open={null}
      onOpenChange={null}
      testId={null}
      className="px-3 py-1.5 text-ui-xs"
      trigger={
        <Button
          ref={buttonRef}
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-current={active}
          data-testid={testId}
          onClick={onClick}
          // Bubbles on to the rail's own trigger, which opens the shared menu.
          onContextMenu={onContextMenu}
          className={cn(
            LEFT_PANEL_RAIL_TILE_CLASS,
            active && activeClass,
            isDragSource && "cursor-grabbing opacity-50",
            dropCue === "join" && LEFT_PANEL_RAIL_COMBINE_TARGET_CLASS,
          )}
        >
          <span
            {...handleListeners}
            className="flex size-full items-center justify-center"
          >
            <LeftPanelRailIcon panelId={panelId} hidden={false} />
            {active ? (
              <DropLine
                orientation={orientation}
                glow={false}
                className={activeIndicatorClass}
                testId={undefined}
              />
            ) : null}
          </span>
        </Button>
      }
    />
  );
}
