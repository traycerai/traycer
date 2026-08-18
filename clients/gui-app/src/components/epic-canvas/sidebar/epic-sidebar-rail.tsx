import {
  Fragment,
  useCallback,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  useDraggable,
  useDroppable,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { DropLine } from "@/components/ui/drop-line";
import {
  getLeftPanelRailDragId,
  getLeftPanelRailDropId,
  getLeftPanelRailListDropId,
  getPaneScopedDndId,
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
  usePanelVisibilityOverrides,
  type LeftPanelGroup,
  type LeftPanelId,
} from "@/stores/epics/left-panel-store";
import { useActiveEpicArtifactId } from "@/stores/epics/canvas/store";
import {
  isLeftPanelVisible,
  LEFT_PANEL_DEFINITIONS,
  resolveActiveVisibleGroupIndex,
  type LeftPanelAvailabilityContext,
  type LeftPanelMetadataDefinition,
} from "@/components/epic-canvas/sidebar/left-panel-registry";
import { useEpicArtifact } from "@/lib/epic-selectors";
import { useCanvasHostId } from "@/components/epic-canvas/hooks/use-canvas-host-id";
import {
  selectPrScopeHasItems,
  usePrPresenceStore,
} from "@/stores/epics/pr-presence-store";
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
  context: LeftPanelAvailabilityContext,
): ReadonlyArray<VisibleLeftPanelGroup> {
  return groups.flatMap((group) => {
    const panelIds = group.panelIds.filter((panelId) =>
      isLeftPanelVisible(getPanelDefinition(panelId), context),
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
  // The host the PR panel records presence under (see `EpicLeftPanelHost`).
  const hostId = useCanvasHostId();
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
  const availabilityContext = useMemo<LeftPanelAvailabilityContext>(
    () => ({
      commentsPanelRevealed,
      hasActiveCommentableArtifact,
      hasPullRequests,
      visibilityOverrideById,
    }),
    [
      commentsPanelRevealed,
      hasActiveCommentableArtifact,
      hasPullRequests,
      visibilityOverrideById,
    ],
  );
  const visibleGroups = useMemo(
    () => getVisibleLeftPanelGroups(panelGroups, availabilityContext),
    [availabilityContext, panelGroups],
  );
  // Which icon lights up. Resolved rather than compared against `activePanelId`
  // directly so a hidden active panel highlights whatever the body fell back
  // to, instead of leaving the rail with nothing marked.
  const activeGroupIndex = resolveActiveVisibleGroupIndex(
    visibleGroups.map((group) => group.panelIds),
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
  // Narrow selector hooks: a rail drag preview tick re-renders ONLY the rail,
  // and a canvas-source preview tick (pane bodies / strips) never reaches it.
  const railPanelDropPreview = useLeftPanelRailDropPreview(tabId);
  const panelSectionDragSource = useLeftPanelSectionDragSource(tabId);
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
            ref={railDropRef}
            onContextMenuCapture={handleRailContextMenuCapture}
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
                    tabId={tabId}
                    panelIds={group.panelIds}
                    primaryPanel={group.primaryPanel}
                    orientation={orientation}
                    active={groupIndex === activeGroupIndex && !collapsed}
                    onClick={() => handleClick(group.panelIds)}
                    onContextMenu={setContextPanelId}
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
        </ContextMenuTrigger>
        <RailContextMenuContent
          context={availabilityContext}
          contextPanelId={contextPanelId}
        />
      </ContextMenu>
    </TooltipProvider>
  );
}

/**
 * Rail context menu: every panel we have, each with a checkmark for whether it
 * is in the rail right now. Unchecking hides a panel; checking one reveals it -
 * including the presence-gated `pull-requests` / `comments`, where an explicit
 * check keeps the icon there even before the thing that would reveal it exists.
 *
 * A choice is stored only when it disagrees with the panel's own rule (see
 * `setPanelVisibilityOverride`), so checking an already-auto-visible panel
 * leaves it following that rule rather than pinning today's answer forever.
 *
 * The last visible panel cannot be unchecked: the sidebar body always renders
 * some panel, so an empty rail would leave the two disagreeing with no icon to
 * click back.
 */
function RailContextMenuContent(props: {
  readonly context: LeftPanelAvailabilityContext;
  readonly contextPanelId: LeftPanelId | null;
}): ReactNode {
  const setOverride = useEpicLeftPanelStore(
    (s) => s.setPanelVisibilityOverride,
  );
  const clearOverrides = useEpicLeftPanelStore(
    (s) => s.clearPanelVisibilityOverrides,
  );
  const { context, contextPanelId } = props;
  const visibility = LEFT_PANEL_DEFINITIONS.map((definition) => ({
    definition,
    visible: isLeftPanelVisible(definition, context),
    autoVisible: definition.isAutoVisible(context),
  }));
  const visibleCount = visibility.filter((entry) => entry.visible).length;
  const entries = visibility.map((entry) => ({
    ...entry,
    // The last one standing stays put; see the note above.
    locked: entry.visible && visibleCount === 1,
  }));
  const hasOverrides = Object.keys(context.visibilityOverrideById).length > 0;
  const pointedEntry =
    entries.find((entry) => entry.definition.id === contextPanelId) ?? null;

  return (
    <ContextMenuContent
      className="min-w-56"
      data-testid="epic-rail-context-menu"
    >
      {pointedEntry !== null && visibleCount > 1 ? (
        <>
          <ContextMenuItem
            onSelect={() => setOverride(pointedEntry.definition.id, false)}
            data-testid="epic-rail-hide-pointed-panel"
          >
            {`Hide '${pointedEntry.definition.title}'`}
          </ContextMenuItem>
          <ContextMenuSeparator />
        </>
      ) : null}
      {entries.map((entry) => (
        <ContextMenuCheckboxItem
          key={entry.definition.id}
          checked={entry.visible}
          disabled={entry.locked}
          onCheckedChange={(next) =>
            setOverride(
              entry.definition.id,
              next === entry.autoVisible ? null : next,
            )
          }
          data-testid={`epic-rail-toggle-${entry.definition.id}`}
        >
          <entry.definition.icon
            className="text-muted-foreground"
            aria-hidden
          />
          {entry.definition.title}
          {entry.visible && !entry.autoVisible ? (
            <span className="ml-auto pl-4 text-ui-xs text-muted-foreground">
              {entry.definition.forcedOnHint}
            </span>
          ) : null}
        </ContextMenuCheckboxItem>
      ))}
      {hasOverrides ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={clearOverrides}
            data-testid="epic-rail-reset-panel-visibility"
          >
            Reset panel visibility
          </ContextMenuItem>
        </>
      ) : null}
    </ContextMenuContent>
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
  readonly tabId: string;
  readonly panelIds: ReadonlyArray<LeftPanelId>;
  readonly primaryPanel: LeftPanelMetadataDefinition;
  readonly orientation: RailOrientation;
  readonly active: boolean;
  readonly onClick: () => void;
  /** Reports the panel under the pointer to the rail-wide context menu. */
  readonly onContextMenu: (panelId: LeftPanelId) => void;
  readonly dropPosition: "combine" | null;
}

function RailGroupButton(props: RailGroupButtonProps) {
  const {
    tabId,
    panelIds,
    primaryPanel,
    orientation,
    active,
    onClick,
    onContextMenu,
    dropPosition,
  } = props;
  const handleContextMenu = useCallback((): void => {
    onContextMenu(primaryPanel.id);
  }, [onContextMenu, primaryPanel.id]);
  const dragData = useMemo<EpicCanvasLeftPanelRailDragData>(
    () => ({
      kind: LEFT_PANEL_RAIL_ITEM_DND_TYPE,
      viewTabId: tabId,
      panelId: primaryPanel.id,
      origin: "rail",
    }),
    [primaryPanel.id, tabId],
  );
  const {
    listeners,
    setNodeRef: dragRef,
    isDragging,
  } = useDraggable({
    id: getPaneScopedDndId(tabId, getLeftPanelRailDragId(primaryPanel.id)),
    data: dragData,
  });
  const dropData = useMemo<EpicCanvasDropTargetData>(
    () => ({
      kind: "left-panel-rail-item",
      viewTabId: tabId,
      panelId: primaryPanel.id,
    }),
    [primaryPanel.id, tabId],
  );
  const { setNodeRef: dropRef, isOver } = useDroppable({
    id: getPaneScopedDndId(tabId, getLeftPanelRailDropId(primaryPanel.id)),
    data: dropData,
  });
  const setButtonRef = useMemo(
    () => mergeRefs<HTMLElement>(dragRef, dropRef),
    [dragRef, dropRef],
  );

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
      onContextMenu={handleContextMenu}
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
  readonly onContextMenu: () => void;
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
    onContextMenu,
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
        onClick={onClick}
        // Bubbles on to the rail's own trigger, which opens the shared menu.
        onContextMenu={onContextMenu}
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
        </span>
      </Button>
    </TooltipWrapper>
  );
}
