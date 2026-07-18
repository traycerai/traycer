import { Fragment, useCallback, useMemo } from "react";
import {
  useDraggable,
  useDroppable,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { Button } from "@/components/ui/button";
import { DropLine } from "@/components/ui/drop-line";
import {
  getLeftPanelRailDragId,
  getLeftPanelRailDropId,
  getLeftPanelRailListDropId,
  LEFT_PANEL_RAIL_ITEM_DND_TYPE,
  type EpicCanvasDropPreview,
  type EpicCanvasDropTargetData,
  type EpicCanvasLeftPanelRailDragData,
} from "@/components/epic-canvas/dnd/dnd";
import {
  useLeftPanelRailDropPreview,
  useLeftPanelSectionDragSource,
} from "@/components/epic-canvas/dnd/dnd-store";
import { mergeRefs } from "@/lib/merge-refs";
import { cn } from "@/lib/utils";
import {
  useActiveLeftPanelId,
  useCommentsPanelRevealed,
  useEpicLeftPanelStore,
  useLeftPanelGroups,
  useMainPanelCollapsed,
  type LeftPanelGroup,
  type LeftPanelId,
} from "@/stores/epics/left-panel-store";
import { useActiveEpicArtifactId } from "@/stores/epics/canvas/store";
import {
  LEFT_PANEL_DEFINITIONS,
  type LeftPanelMetadataDefinition,
} from "@/components/epic-canvas/sidebar/left-panel-registry";
import { useEpicArtifact } from "@/lib/epic-selectors";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import {
  selectPrHasChangedDot,
  usePrSeenFactsStore,
} from "@/stores/epics/pr-seen-facts-store";
import { type LucideIcon } from "lucide-react";

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

interface VisibleLeftPanelGroup {
  readonly panelIds: ReadonlyArray<LeftPanelId>;
  readonly primaryPanel: LeftPanelMetadataDefinition;
}

const PANEL_DEFINITION_BY_ID = new Map(
  LEFT_PANEL_DEFINITIONS.map((definition) => [definition.id, definition]),
);

function getPanelDefinition(panelId: LeftPanelId): LeftPanelMetadataDefinition {
  const definition = PANEL_DEFINITION_BY_ID.get(panelId);
  if (definition !== undefined) return definition;
  return LEFT_PANEL_DEFINITIONS[0];
}

function getVisibleLeftPanelGroups(
  groups: ReadonlyArray<LeftPanelGroup>,
  commentsPanelRevealed: boolean,
  hasActiveCommentableArtifact: boolean,
): ReadonlyArray<VisibleLeftPanelGroup> {
  const context = { commentsPanelRevealed, hasActiveCommentableArtifact };
  return groups.flatMap((group) => {
    const panelIds = group.panelIds.filter((panelId) =>
      getPanelDefinition(panelId).isVisible(context),
    );
    if (panelIds.length === 0) return [];
    return [
      {
        panelIds,
        primaryPanel: getPanelDefinition(panelIds[0]),
      },
    ];
  });
}

function getRailBoundaryIndex(
  groups: ReadonlyArray<VisibleLeftPanelGroup>,
  dropPreview: EpicCanvasDropPreview,
): number | null {
  if (dropPreview?.kind === "left-panel-rail-list") return groups.length;
  if (dropPreview?.kind !== "left-panel-rail") return null;
  if (dropPreview.position === "combine") return null;
  const groupIndex = groups.findIndex(
    (group) => group.primaryPanel.id === dropPreview.panelId,
  );
  if (groupIndex < 0) return null;
  return dropPreview.position === "before" ? groupIndex : groupIndex + 1;
}

/**
 * VS Code-style mini rail. Always visible (~3rem wide). Clicking an
 * inactive icon switches the active panel and expands the main panel if
 * collapsed. Clicking the already-active group toggles main panel
 * collapse. Dragging before/after reorders groups; dragging onto the
 * middle of another icon combines those panels into one rail group.
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
  const panelGroups = useLeftPanelGroups();
  const commentsPanelRevealed = useCommentsPanelRevealed(tabId);
  const setActivePanelIdAndExpand = useEpicLeftPanelStore(
    (s) => s.setActivePanelIdAndExpand,
  );
  const toggleMainCollapsed = useEpicLeftPanelStore(
    (s) => s.toggleMainCollapsed,
  );
  const visibleGroups = useMemo(
    () =>
      getVisibleLeftPanelGroups(
        panelGroups,
        commentsPanelRevealed,
        hasActiveCommentableArtifact,
      ),
    [commentsPanelRevealed, hasActiveCommentableArtifact, panelGroups],
  );
  const railListDropData = useMemo<EpicCanvasDropTargetData>(
    () => ({ kind: "left-panel-rail-list" }),
    [],
  );
  const { setNodeRef: railDropRef } = useDroppable({
    id: getLeftPanelRailListDropId(epicId),
    data: railListDropData,
  });
  // Narrow selector hooks: a rail drag preview tick re-renders ONLY the rail,
  // and a canvas-source preview tick (pane bodies / strips) never reaches it.
  const railPanelDropPreview = useLeftPanelRailDropPreview();
  const panelSectionDragSource = useLeftPanelSectionDragSource();
  const panelSectionDropDefinition =
    panelSectionDragSource === null
      ? null
      : getPanelDefinition(panelSectionDragSource.panelId);
  const railBoundaryIndex = getRailBoundaryIndex(
    visibleGroups,
    railPanelDropPreview,
  );

  const handleClick = useCallback(
    (groupPanelIds: ReadonlyArray<LeftPanelId>) => {
      if (groupPanelIds.includes(activePanelId)) {
        toggleMainCollapsed(tabId);
        return;
      }
      setActivePanelIdAndExpand(tabId, groupPanelIds[0]);
    },
    [activePanelId, setActivePanelIdAndExpand, tabId, toggleMainCollapsed],
  );

  return (
    <TooltipProvider delayDuration={150}>
      <div
        ref={railDropRef}
        role="toolbar"
        aria-label="Epic left panels"
        aria-orientation={orientation}
        data-testid="epic-sidebar-rail"
        data-orientation={orientation}
        className={cn(
          "relative flex items-center gap-1 bg-background",
          orientation === "vertical" &&
            "h-full w-12 shrink-0 flex-col justify-start overflow-y-auto py-2",
          orientation === "horizontal" &&
            "h-10 w-full min-w-0 flex-row justify-center overflow-x-auto px-2",
        )}
      >
        {railBoundaryIndex === 0 ? (
          <RailBoundaryPreview
            definition={panelSectionDropDefinition}
            orientation={orientation}
          />
        ) : null}
        {visibleGroups.map((group, groupIndex) => {
          const groupDropPosition =
            railPanelDropPreview?.kind === "left-panel-rail" &&
            railPanelDropPreview.panelId === group.primaryPanel.id
              ? railPanelDropPreview.position
              : null;
          return (
            <Fragment key={group.primaryPanel.id}>
              <RailGroupButton
                epicId={epicId}
                panelIds={group.panelIds}
                primaryPanel={group.primaryPanel}
                orientation={orientation}
                active={group.panelIds.includes(activePanelId) && !collapsed}
                onClick={() => handleClick(group.panelIds)}
                dropPosition={
                  groupDropPosition === "combine" ? "combine" : null
                }
              />
              {railBoundaryIndex === groupIndex + 1 ? (
                <RailBoundaryPreview
                  definition={panelSectionDropDefinition}
                  orientation={orientation}
                />
              ) : null}
            </Fragment>
          );
        })}
      </div>
    </TooltipProvider>
  );
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

interface RailGroupButtonProps {
  readonly epicId: string;
  readonly panelIds: ReadonlyArray<LeftPanelId>;
  readonly primaryPanel: LeftPanelMetadataDefinition;
  readonly orientation: RailOrientation;
  readonly active: boolean;
  readonly onClick: () => void;
  readonly dropPosition: "combine" | null;
}

function RailGroupButton(props: RailGroupButtonProps) {
  const {
    epicId,
    panelIds,
    primaryPanel,
    orientation,
    active,
    onClick,
    dropPosition,
  } = props;
  const dragData = useMemo<EpicCanvasLeftPanelRailDragData>(
    () => ({
      kind: LEFT_PANEL_RAIL_ITEM_DND_TYPE,
      panelId: primaryPanel.id,
      origin: "rail",
    }),
    [primaryPanel.id],
  );
  const {
    listeners,
    setNodeRef: dragRef,
    isDragging,
  } = useDraggable({
    id: getLeftPanelRailDragId(primaryPanel.id),
    data: dragData,
  });
  const dropData = useMemo<EpicCanvasDropTargetData>(
    () => ({
      kind: "left-panel-rail-item",
      panelId: primaryPanel.id,
    }),
    [primaryPanel.id],
  );
  const { setNodeRef: dropRef, isOver } = useDroppable({
    id: getLeftPanelRailDropId(primaryPanel.id),
    data: dropData,
  });
  const setButtonRef = useMemo(
    () => mergeRefs<HTMLElement>(dragRef, dropRef),
    [dragRef, dropRef],
  );

  const hostId = useReactiveActiveHostId();
  const prChangedDot = usePrSeenFactsStore(
    selectPrHasChangedDot(hostId, epicId),
  );
  const showChangedDot = panelIds.includes("pull-requests") && prChangedDot;

  return (
    <RailButton
      buttonRef={setButtonRef}
      handleListeners={listeners}
      icons={panelIds.map((panelId) => getPanelDefinition(panelId).icon)}
      label={panelIds
        .map((panelId) => getPanelDefinition(panelId).title)
        .join(" + ")}
      orientation={orientation}
      active={active}
      isDragSource={isDragging}
      isDropTarget={isOver}
      dropPosition={dropPosition}
      testId={`epic-rail-${primaryPanel.id}`}
      onClick={onClick}
      showChangedDot={showChangedDot}
    />
  );
}

interface RailButtonProps {
  readonly buttonRef: (element: HTMLElement | null) => void;
  readonly handleListeners: DraggableSyntheticListeners;
  readonly icons: ReadonlyArray<LucideIcon>;
  readonly label: string;
  readonly orientation: RailOrientation;
  readonly active: boolean;
  readonly isDragSource: boolean;
  readonly isDropTarget: boolean;
  readonly dropPosition: "combine" | null;
  readonly testId: string;
  readonly onClick: () => void;
  readonly showChangedDot: boolean;
}

function RailButton(props: RailButtonProps) {
  const {
    buttonRef,
    handleListeners,
    icons,
    label,
    orientation,
    active,
    isDragSource,
    isDropTarget,
    dropPosition,
    testId,
    onClick,
    showChangedDot,
  } = props;
  const Icon = icons[0] ?? getPanelDefinition("chats").icon;
  const activeClass =
    orientation === "vertical"
      ? "bg-accent text-accent-foreground hover:bg-accent"
      : "text-foreground hover:bg-transparent";
  const activeIndicatorClass =
    orientation === "vertical"
      ? "absolute inset-y-1 left-0 rounded-l-none rounded-r"
      : "absolute inset-x-2 bottom-0 rounded-b-none rounded-t";
  return (
    <TooltipWrapper
      label={label}
      side={orientation === "vertical" ? "right" : "bottom"}
      sideOffset={undefined}
      align={undefined}
    >
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        aria-current={active}
        data-testid={testId}
        data-pr-changed-dot={showChangedDot ? "true" : "false"}
        onClick={onClick}
        className={cn(
          "relative size-9 rounded-md text-muted-foreground hover:text-foreground",
          active && activeClass,
          isDragSource && "cursor-grabbing opacity-50",
          dropPosition === "combine" &&
            "bg-primary/10 text-foreground ring-1 ring-primary/60",
          isDropTarget && dropPosition === null && "bg-accent/70",
        )}
      >
        <span
          {...handleListeners}
          className="flex size-full items-center justify-center"
        >
          <Icon className="size-4" />
          {active ? (
            <DropLine
              orientation={orientation}
              glow={false}
              className={activeIndicatorClass}
              testId={undefined}
            />
          ) : null}
          {showChangedDot ? (
            <span
              aria-hidden
              data-testid="pr-changed-dot"
              className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-primary"
            />
          ) : null}
        </span>
      </Button>
    </TooltipWrapper>
  );
}
