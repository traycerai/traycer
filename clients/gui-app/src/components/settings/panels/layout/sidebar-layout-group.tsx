/**
 * Layout ▸ Sidebar: the epic sidebar's own layout.
 *
 * The Panels block is a SECOND VIEW onto `left-panel-store`, never a second
 * source of truth. Its checkboxes write the override the rail's right-click
 * menu writes, and its reordering commits through `applyPanelGroups` after
 * resolving with the same pure `moveLeftPanel*` helpers the rail's DnD uses
 * (see `sidebar-panel-moves.ts`). So a change here is on the rail immediately,
 * a change on the rail is here, and neither can express a grouping the other
 * cannot.
 *
 * It is drawn as the rail is drawn: a strip of tiles across the top, in the
 * rail's own tile size and tab underline, and that strip is the ONLY drag
 * surface. The cards below carry what a tile cannot say - the panel's name, its
 * visibility checkbox, and the keyboard path through the row menu.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragOverEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core";
import { EllipsisVertical } from "lucide-react";
import {
  getLeftPanelRailDropPositionOnAxis,
  type LeftPanelRailDropPosition,
} from "@/components/epic-canvas/dnd/dnd";
import {
  LEFT_PANEL_RAIL_COMBINE_TARGET_CLASS,
  LEFT_PANEL_RAIL_TAB_UNDERLINE_CLASS,
  LEFT_PANEL_RAIL_TILE_CLASS,
} from "@/components/epic-canvas/sidebar/left-panel-rail-tile";
import {
  getLeftPanelDefinition,
  isLeftPanelVisible,
  LEFT_PANEL_DEFINITIONS,
  type LeftPanelAvailabilityContext,
} from "@/components/epic-canvas/sidebar/left-panel-registry";
import { trackLayoutSetting } from "@/components/settings/panels/layout/track-layout-setting";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import {
  groupSidebarPanelWithPrevious,
  moveSidebarPanelDown,
  moveSidebarPanelUp,
  isSidebarPanelGroupBoundary,
  resolveSidebarPanelDrop,
  sidebarPanelRowActions,
  ungroupSidebarPanel,
} from "@/components/settings/panels/layout/sidebar-panel-moves";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropLine } from "@/components/ui/drop-line";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { mergeRefs } from "@/lib/merge-refs";
import { cn } from "@/lib/utils";
import { useSettingsDensity } from "@/providers/settings-density-context";
import { useSettingsStore } from "@/stores/settings/settings-store";
import {
  areLeftPanelGroupsEqual,
  DEFAULT_LEFT_PANEL_GROUPS,
  LEFT_PANEL_IDS,
  useLeftPanelGroups,
  useLeftPanelStore,
  usePanelVisibilityOverrides,
  type LeftPanelGroup,
  type LeftPanelId,
} from "@/stores/epics/left-panel-store";

/**
 * The presence facts the rail reads from the epic under the pointer, answered
 * for a page that has no epic in view: a presence-gated panel is off unless
 * the user has explicitly forced it on. That is the same answer the rail gives
 * for an epic with no PRs and no open artifact, so the checkbox column here
 * describes the panel's standing preference rather than one epic's contents.
 */
const SETTINGS_PRESENCE: Omit<
  LeftPanelAvailabilityContext,
  "visibilityOverrideById"
> = {
  commentsPanelRevealed: false,
  hasActiveCommentableArtifact: false,
  hasPullRequests: false,
};

export function SidebarLayoutGroup(): ReactNode {
  const showNavigatorResourceStats = useSettingsStore(
    (state) => state.showNavigatorResourceStats,
  );
  const setShowNavigatorResourceStats = useSettingsStore(
    (state) => state.setShowNavigatorResourceStats,
  );
  return (
    <SettingsGroup
      title="Sidebar"
      tone="default"
      dataTestId="layout-sidebar-group"
      fill={false}
    >
      <SettingsRow
        label="Show resource chips on sidebar rows"
        description="Show compact live CPU and memory chips in task navigator rows."
        control={
          <Switch
            checked={showNavigatorResourceStats}
            onCheckedChange={(value) => {
              trackLayoutSetting("showNavigatorResourceStats");
              setShowNavigatorResourceStats(value);
            }}
            aria-label="Show resource chips on sidebar rows"
          />
        }
      />
      <SidebarPanelsSection />
    </SettingsGroup>
  );
}

/**
 * The panel block, or a note in its place.
 *
 * The gate is the VIEWPORT, not the build: `epic-surface.tsx` drops the whole
 * sidebar column - rail included - below `md`, so on a narrow window there is
 * no rail for an order or a visibility choice to describe. That is a question
 * resizing the window changes, which is exactly the line
 * `use-mobile-viewport.ts` draws between the two signals; the Status bar
 * group's `isMobileApp()` answers a different question (the footer is never
 * drawn in that PRODUCT) and would be wrong here, since a tablet running the
 * installed app is wide enough to draw the rail.
 */
function SidebarPanelsSection(): ReactNode {
  const narrowViewport = useIsMobileViewport();
  if (narrowViewport) {
    return (
      <SettingsRow
        label="Panel layout needs the sidebar"
        description="The epic sidebar and its panel rail are only drawn on wider windows, so there is nothing to arrange here."
        control={null}
      />
    );
  }
  return <SidebarPanelList />;
}

interface SidebarPanelDropPreview {
  readonly targetPanelId: LeftPanelId;
  readonly position: LeftPanelRailDropPosition;
}

function SidebarPanelList(): ReactNode {
  const compact = useSettingsDensity() === "compact";
  const groups = useLeftPanelGroups();
  const overrides = usePanelVisibilityOverrides();
  const applyPanelGroups = useLeftPanelStore((state) => state.applyPanelGroups);
  const clearOverrides = useLeftPanelStore(
    (state) => state.clearPanelVisibilityOverrides,
  );
  const [preview, setPreview] = useState<SidebarPanelDropPreview | null>(null);
  // What the last row-menu move did, for anyone who cannot see the list move.
  const [announcement, setAnnouncement] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const pendingFocusPanelIdRef = useRef<LeftPanelId | null>(null);
  // The ONLY pointer source for the band math below, stashed by the collision
  // pass for the same reason `queued-message-reorder-dnd.ts` stashes it: the
  // event `delta` is scroll-adjusted while droppable rects are not, so
  // reconstructing the pointer from the activator event drifts once the
  // settings body scrolls mid-drag.
  const pointerRef = useRef<{ readonly x: number; readonly y: number } | null>(
    null,
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const context = useMemo<LeftPanelAvailabilityContext>(
    () => ({ ...SETTINGS_PRESENCE, visibilityOverrideById: overrides }),
    [overrides],
  );
  const visibleCount = LEFT_PANEL_DEFINITIONS.filter((definition) =>
    isLeftPanelVisible(definition, context),
  ).length;
  const hasOverrides = Object.keys(overrides).length > 0;
  const isDefaultOrder = areLeftPanelGroupsEqual(
    groups,
    DEFAULT_LEFT_PANEL_GROUPS,
  );

  const commitGroups = useCallback(
    (nextGroups: ReadonlyArray<LeftPanelGroup>): boolean => {
      if (areLeftPanelGroupsEqual(groups, nextGroups)) return false;
      trackLayoutSetting("layout.sidebar.panelOrder");
      applyPanelGroups(nextGroups);
      return true;
    },
    [applyPanelGroups, groups],
  );

  /**
   * A row-menu move, which owes the keyboard two things a drag does not.
   *
   * A card is keyed by its first panel, so any move that changes which card a
   * row lives in - or which panel a card leads with - unmounts the row and its
   * menu trigger while Radix is still closing the menu. Radix then restores
   * focus to a trigger React has already nulled, and it lands on `<body>`, so
   * the next move needs a full tab back into the list. Re-aiming focus at the
   * panel's NEW trigger keeps the user where they were working; the live region
   * says where the panel went, since nothing else tells a screen reader that a
   * silent list two levels away just changed shape.
   */
  const runRowAction = useCallback(
    (panelId: LeftPanelId, nextGroups: ReadonlyArray<LeftPanelGroup>): void => {
      if (!commitGroups(nextGroups)) return;
      pendingFocusPanelIdRef.current = panelId;
      setAnnouncement(describePanelPlacement(nextGroups, panelId));
    },
    [commitGroups],
  );

  useEffect(() => {
    const panelId = pendingFocusPanelIdRef.current;
    if (panelId === null) return;
    pendingFocusPanelIdRef.current = null;
    // Found by testid rather than a ref threaded through two `asChild` layers:
    // what has to be focused is the DOM node Radix ends up rendering, and this
    // cannot be broken by a change in how it composes refs.
    const trigger = listRef.current?.querySelector(
      `[data-testid="${panelMenuTestId(panelId)}"]`,
    );
    if (trigger instanceof HTMLElement) trigger.focus();
  }, [groups]);

  const collisionDetection = useCallback<CollisionDetection>((args) => {
    const point = args.pointerCoordinates;
    pointerRef.current = point === null ? null : { x: point.x, y: point.y };
    return closestCenter(args);
  }, []);

  const resolvePreview = useCallback(
    (
      event: DragEndEvent | DragMoveEvent | DragOverEvent,
    ): SidebarPanelDropPreview | null => {
      const sourcePanelId = readPanelId(event.active.id);
      const over = event.over;
      const point = pointerRef.current;
      if (sourcePanelId === null || over === null || point === null)
        return null;
      const targetPanelId = readPanelId(over.id);
      if (targetPanelId === null) return null;
      // The strip lays the rail's slots out in a ROW, so the rail's bands are
      // read along x here; the fractions, and the three outcomes they resolve
      // to, are the rail's own.
      const position = getLeftPanelRailDropPositionOnAxis(
        point,
        over.rect,
        "x",
      );
      // A drop that lands the panel where it already is draws nothing, so the
      // indicator can never promise a move the commit would decline.
      const nextGroups = resolveSidebarPanelDrop(
        groups,
        sourcePanelId,
        targetPanelId,
        position,
      );
      if (areLeftPanelGroupsEqual(groups, nextGroups)) return null;
      return { targetPanelId, position };
    },
    [groups],
  );

  const handleDragMove = useCallback(
    (event: DragMoveEvent | DragOverEvent): void => {
      const next = resolvePreview(event);
      setPreview((current) => (samePreview(current, next) ? current : next));
    },
    [resolvePreview],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent): void => {
      const sourcePanelId = readPanelId(event.active.id);
      const dropped = resolvePreview(event);
      setPreview(null);
      pointerRef.current = null;
      if (sourcePanelId === null || dropped === null) return;
      commitGroups(
        resolveSidebarPanelDrop(
          groups,
          sourcePanelId,
          dropped.targetPanelId,
          dropped.position,
        ),
      );
    },
    [commitGroups, groups, resolvePreview],
  );

  const handleDragCancel = useCallback((): void => {
    setPreview(null);
    pointerRef.current = null;
  }, []);

  return (
    <div
      ref={listRef}
      data-testid="layout-sidebar-panels"
      className={cn(
        "space-y-2 border-b border-border/40 last:border-b-0",
        compact ? "px-4 py-2.5" : "px-5 py-4",
      )}
    >
      <div className="space-y-1">
        <div className="font-medium text-foreground">Panels</div>
        <p className="max-w-[72ch] text-pretty text-ui-sm text-muted-foreground">
          Drag icons to reorder. Drop one onto another to make a tabbed panel.
          Dimmed icons are unchecked below.
        </p>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragMove={handleDragMove}
        onDragOver={handleDragMove}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SidebarPanelRailStrip
          groups={groups}
          context={context}
          preview={preview}
        />
      </DndContext>
      <p className="max-w-[72ch] text-pretty text-ui-sm text-muted-foreground">
        Uncheck a panel to keep it out of the rail.
      </p>
      <div className="space-y-1.5">
        {groups.map((group) => (
          <SidebarPanelCard
            key={group.panelIds[0]}
            group={group}
            groups={groups}
            context={context}
            visibleCount={visibleCount}
            onRunAction={runRowAction}
          />
        ))}
      </div>
      <span className="sr-only" role="status" aria-live="polite">
        {announcement}
      </span>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!hasOverrides}
          onClick={() => {
            trackLayoutSetting("layout.sidebar.resetVisibility");
            clearOverrides();
          }}
        >
          Reset panel visibility
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isDefaultOrder}
          onClick={() => {
            trackLayoutSetting("layout.sidebar.resetOrder");
            applyPanelGroups(DEFAULT_LEFT_PANEL_GROUPS);
          }}
        >
          Reset order
        </Button>
      </div>
    </div>
  );
}

interface SidebarPanelRailStripProps {
  readonly groups: ReadonlyArray<LeftPanelGroup>;
  readonly context: LeftPanelAvailabilityContext;
  readonly preview: SidebarPanelDropPreview | null;
}

/**
 * The rail, as the page can draw it: every panel in `panelGroups` order, in the
 * rail's own tile, with a tabbed group drawn as one pill under the rail's tab
 * underline. A dimmed tile is one whose checkbox below is unchecked - which is
 * not the same claim as "absent from the rail", since the checkbox answers a
 * page with no epic in view (see `SETTINGS_PRESENCE`) and a presence-gated
 * panel can be dimmed here while an epic with PRs draws it. The dim keeps its
 * slot rather than dropping out, because this strip is about WHERE a panel
 * sits: removing tiles would shift every icon after them out of agreement with
 * the cards.
 *
 * `aria-hidden`, and deliberately: it is a picture of the cards underneath,
 * which carry each panel's name, its checkbox and its menu. A second,
 * unlabelled pass over the same nine panels would only lengthen the tab order.
 * The keyboard path to every move this strip offers is the row menu.
 */
function SidebarPanelRailStrip(props: SidebarPanelRailStripProps): ReactNode {
  const { groups, context, preview } = props;
  return (
    <div
      aria-hidden
      data-testid="layout-sidebar-panel-strip"
      className="flex w-full min-w-0 flex-wrap items-center gap-2 rounded-md border border-border/60 bg-foreground/3 px-2 py-2"
    >
      {groups.map((group) =>
        group.panelIds.length > 1 ? (
          <SidebarPanelStripPill
            key={group.panelIds[0]}
            group={group}
            groups={groups}
            context={context}
            preview={preview}
          />
        ) : (
          <SidebarPanelStripTile
            key={group.panelIds[0]}
            panelId={group.panelIds[0]}
            groups={groups}
            context={context}
            preview={preview}
            ownsCombineHighlight
          />
        ),
      )}
    </div>
  );
}

interface SidebarPanelStripPillProps {
  readonly group: LeftPanelGroup;
  readonly groups: ReadonlyArray<LeftPanelGroup>;
  readonly context: LeftPanelAvailabilityContext;
  readonly preview: SidebarPanelDropPreview | null;
}

/**
 * A tabbed group: its member tiles together under one of the rail's tab
 * underlines, which is what makes them read as one panel rather than as
 * neighbours.
 *
 * The pill, not the tile, carries the combine highlight. A drop onto any member
 * appends the panel to that member's whole GROUP (`moveLeftPanelToGroup`), so
 * lighting only the tile under the pointer would name a smaller thing than the
 * drop does. On the rail the two coincide, because a rail tile IS a group.
 */
function SidebarPanelStripPill(props: SidebarPanelStripPillProps): ReactNode {
  const { group, groups, context, preview } = props;
  const combineTarget =
    preview !== null &&
    preview.position === "combine" &&
    group.panelIds.includes(preview.targetPanelId);
  return (
    <div
      data-testid={`layout-sidebar-panel-pill-${group.panelIds[0]}`}
      className={cn(
        "relative flex shrink-0 items-center rounded-md bg-foreground/6 px-0.5",
        combineTarget && LEFT_PANEL_RAIL_COMBINE_TARGET_CLASS,
      )}
    >
      {group.panelIds.map((panelId) => (
        <SidebarPanelStripTile
          key={panelId}
          panelId={panelId}
          groups={groups}
          context={context}
          preview={preview}
          ownsCombineHighlight={false}
        />
      ))}
      <DropLine
        orientation="horizontal"
        glow={false}
        className={LEFT_PANEL_RAIL_TAB_UNDERLINE_CLASS}
        testId={`layout-sidebar-panel-pill-underline-${group.panelIds[0]}`}
      />
    </div>
  );
}

interface SidebarPanelStripTileProps {
  readonly panelId: LeftPanelId;
  readonly groups: ReadonlyArray<LeftPanelGroup>;
  readonly context: LeftPanelAvailabilityContext;
  readonly preview: SidebarPanelDropPreview | null;
  /** False for a pill's member, whose pill draws the highlight for it. */
  readonly ownsCombineHighlight: boolean;
}

function SidebarPanelStripTile(props: SidebarPanelStripTileProps): ReactNode {
  const { panelId, groups, context, preview, ownsCombineHighlight } = props;
  const definition = getLeftPanelDefinition(panelId);
  const {
    listeners,
    setNodeRef: dragRef,
    isDragging,
  } = useDraggable({ id: panelId });
  const { setNodeRef: dropRef } = useDroppable({ id: panelId });
  const setTileRef = useMemo(
    () => mergeRefs<HTMLDivElement>(dragRef, dropRef),
    [dragRef, dropRef],
  );
  const previewPosition =
    preview !== null && preview.targetPanelId === panelId
      ? preview.position
      : null;
  const hidden = !isLeftPanelVisible(definition, context);
  const Icon = definition.icon;

  return (
    <div className="relative flex shrink-0 items-center">
      {previewPosition === "before" ? (
        <SidebarPanelStripDropLine
          edge="start"
          spansGroup={isSidebarPanelGroupBoundary(groups, panelId, "before")}
        />
      ) : null}
      {/* The rail names its icons the same way, and here it is the only name a
          tile has: the strip is `aria-hidden`, so nothing else says which panel
          a user is about to drag. */}
      <TooltipWrapper
        label={definition.title}
        side="bottom"
        sideOffset={undefined}
        align={undefined}
      >
        <div
          ref={setTileRef}
          {...listeners}
          data-testid={`layout-sidebar-panel-tile-${panelId}`}
          className={cn(
            LEFT_PANEL_RAIL_TILE_CLASS,
            "flex cursor-grab touch-none items-center justify-center",
            isDragging && "cursor-grabbing opacity-50",
            ownsCombineHighlight &&
              previewPosition === "combine" &&
              LEFT_PANEL_RAIL_COMBINE_TARGET_CLASS,
          )}
        >
          {/* The dim sits on the ICON, not the tile: nesting into a hidden
              panel is a legitimate drop, and the ring that offers it would be
              dimmed along with everything else if the tile carried it. */}
          <Icon className={cn("size-4", hidden && "opacity-40")} />
        </div>
      </TooltipWrapper>
      {previewPosition === "after" ? (
        <SidebarPanelStripDropLine
          edge="end"
          spansGroup={isSidebarPanelGroupBoundary(groups, panelId, "after")}
        />
      ) : null}
    </div>
  );
}

/**
 * Where the panel would land, drawn so the two OUTCOMES look different: a line
 * standing clear of the strip's tiles lands the panel in a group of its own, a
 * line drawn between two tiles inside a pill nests it there at that index. Same
 * boundary rule the drop resolves through, so the picture cannot promise a
 * grouping the commit would not make.
 */
function SidebarPanelStripDropLine(props: {
  readonly edge: "start" | "end";
  readonly spansGroup: boolean;
}): ReactNode {
  return (
    <DropLine
      orientation="vertical"
      glow={props.spansGroup}
      className={cn(
        "absolute z-10",
        // A group-boundary line stands taller than the tiles, clearing the pill
        // it is about to put the panel outside of; an in-pill one sits inside
        // them, between the two tabs it would land between.
        props.spansGroup ? "-inset-y-1" : "inset-y-1.5",
        props.edge === "start" && (props.spansGroup ? "-left-1" : "-left-px"),
        props.edge === "end" && (props.spansGroup ? "-right-1" : "-right-px"),
      )}
      testId="layout-sidebar-panel-drop-line"
    />
  );
}

interface SidebarPanelCardProps {
  readonly group: LeftPanelGroup;
  readonly groups: ReadonlyArray<LeftPanelGroup>;
  readonly context: LeftPanelAvailabilityContext;
  readonly visibleCount: number;
  readonly onRunAction: (
    panelId: LeftPanelId,
    groups: ReadonlyArray<LeftPanelGroup>,
  ) => void;
}

/**
 * One group, in the detail a tile has no room for. A tabbed group says so in a
 * header row and repeats the strip's pill as a mini tab strip of member names,
 * then hangs its members off a connector line - so a card that is one panel and
 * a card that is three are told apart before any label is read. A single-panel
 * group is the row alone, with no header and no connector to explain.
 */
function SidebarPanelCard(props: SidebarPanelCardProps): ReactNode {
  const { group, groups, context, visibleCount, onRunAction } = props;
  const tabbed = group.panelIds.length > 1;
  return (
    <div
      data-testid={`layout-sidebar-panel-group-${group.panelIds[0]}`}
      className="rounded-md border border-border/60 bg-foreground/3 p-1"
    >
      {tabbed ? <SidebarPanelCardHeader panelIds={group.panelIds} /> : null}
      <div className={cn(tabbed && "ml-2.5 border-l border-border/60 pl-2")}>
        {group.panelIds.map((panelId) => (
          <SidebarPanelRow
            key={panelId}
            panelId={panelId}
            groups={groups}
            context={context}
            visibleCount={visibleCount}
            onRunAction={onRunAction}
          />
        ))}
      </div>
    </div>
  );
}

function SidebarPanelCardHeader(props: {
  readonly panelIds: ReadonlyArray<LeftPanelId>;
}): ReactNode {
  return (
    <div
      data-testid={`layout-sidebar-panel-group-header-${props.panelIds[0]}`}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1.5 pb-1 pt-0.5"
    >
      <span className="text-ui-xs font-medium uppercase tracking-wide text-muted-foreground">
        Tabbed panel
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-1">
        {props.panelIds.map((panelId) => (
          <span
            key={panelId}
            className="truncate border-b-2 border-primary px-1 pb-0.5 text-ui-xs text-foreground"
          >
            {getLeftPanelDefinition(panelId).title}
          </span>
        ))}
      </span>
    </div>
  );
}

interface SidebarPanelRowProps {
  readonly panelId: LeftPanelId;
  readonly groups: ReadonlyArray<LeftPanelGroup>;
  readonly context: LeftPanelAvailabilityContext;
  readonly visibleCount: number;
  readonly onRunAction: (
    panelId: LeftPanelId,
    groups: ReadonlyArray<LeftPanelGroup>,
  ) => void;
}

function SidebarPanelRow(props: SidebarPanelRowProps): ReactNode {
  const { panelId, groups, context, visibleCount, onRunAction } = props;
  const definition = getLeftPanelDefinition(panelId);
  const setOverride = useLeftPanelStore(
    (state) => state.setPanelVisibilityOverride,
  );

  const visible = isLeftPanelVisible(definition, context);
  const autoVisible = definition.isAutoVisible(context);
  // The last panel standing keeps its slot, exactly as in the rail menu: the
  // sidebar body always renders SOME panel, so an empty rail would leave the
  // two disagreeing with no icon to click back.
  const locked = visible && visibleCount === 1;
  const actions = sidebarPanelRowActions(groups, panelId);
  const Icon = definition.icon;

  return (
    <div
      data-testid={`layout-sidebar-panel-${panelId}`}
      className="flex items-center gap-2 rounded-sm px-1.5 py-1"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate text-ui-sm text-foreground">
        {definition.title}
      </span>
      {visible && !autoVisible && definition.forcedOnHint !== null ? (
        <span className="truncate text-ui-xs text-muted-foreground">
          {definition.forcedOnHint}
        </span>
      ) : null}
      <Checkbox
        className="ml-auto"
        checked={visible}
        disabled={locked}
        aria-label={definition.title}
        onCheckedChange={(next) => {
          if (next === "indeterminate") return;
          trackLayoutSetting("layout.sidebar.panelVisibility");
          // An unconditional panel drops its override when the box agrees with
          // the panel's own rule, exactly as the rail's checkbox items do, so
          // re-checking it goes back to following that rule rather than
          // pinning today's answer forever.
          //
          // A CONTEXT-DEPENDENT panel (`forcedOnHint !== null` is that
          // predicate) always stores the boolean instead. `autoVisible` is
          // answered here against a page with no epic in view, so it is always
          // `false` for those two - and clearing on `false` would silently
          // delete a `false` the user set from the rail inside an epic that
          // HAS PRs, turning an off-then-on-again round trip into a reversal.
          // Storing it also makes "never show this" authorable from this page.
          // The cost is real and intended: an explicit `false` on `comments`
          // blocks `setActivePanelIdAndExpand`'s reveal path too, which is
          // what an unchecked box promises.
          setOverride(
            panelId,
            definition.forcedOnHint === null && next === autoVisible
              ? null
              : next,
          );
        }}
      />
      <SidebarPanelRowMenu
        panelId={panelId}
        title={definition.title}
        groups={groups}
        canMoveUp={actions.canMoveUp}
        canMoveDown={actions.canMoveDown}
        canGroupWithPrevious={actions.canGroupWithPrevious}
        canUngroup={actions.canUngroup}
        onRunAction={onRunAction}
      />
    </div>
  );
}

interface SidebarPanelRowMenuProps {
  readonly panelId: LeftPanelId;
  readonly title: string;
  readonly groups: ReadonlyArray<LeftPanelGroup>;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly canGroupWithPrevious: boolean;
  readonly canUngroup: boolean;
  readonly onRunAction: (
    panelId: LeftPanelId,
    groups: ReadonlyArray<LeftPanelGroup>,
  ) => void;
}

/**
 * The pointer-free path through the same move helpers the strip's drag resolves
 * through, so every order a keyboard user reaches is an order a drag could have
 * produced. Not always in ONE drag: swapping the two members of a two-panel
 * pill takes a step here and two by pointer, because every boundary inside such
 * a pill is a no-op.
 */
function SidebarPanelRowMenu(props: SidebarPanelRowMenuProps): ReactNode {
  const { panelId, title, groups, onRunAction } = props;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`${title} panel actions`}
          data-testid={panelMenuTestId(panelId)}
        >
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        <DropdownMenuItem
          disabled={!props.canMoveUp}
          onSelect={() =>
            onRunAction(panelId, moveSidebarPanelUp(groups, panelId))
          }
        >
          Move up
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!props.canMoveDown}
          onSelect={() =>
            onRunAction(panelId, moveSidebarPanelDown(groups, panelId))
          }
        >
          Move down
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!props.canGroupWithPrevious}
          onSelect={() =>
            onRunAction(panelId, groupSidebarPanelWithPrevious(groups, panelId))
          }
        >
          Group with panel above
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!props.canUngroup}
          onSelect={() =>
            onRunAction(panelId, ungroupSidebarPanel(groups, panelId))
          }
        >
          Move out of group
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function panelMenuTestId(panelId: LeftPanelId): string {
  return `layout-sidebar-panel-menu-${panelId}`;
}

/**
 * Where a panel ended up, in the terms the cards show: its place in the whole
 * order, and who it shares a card with.
 */
function describePanelPlacement(
  groups: ReadonlyArray<LeftPanelGroup>,
  panelId: LeftPanelId,
): string {
  const orderedPanelIds = groups.flatMap((group) => group.panelIds);
  const title = getLeftPanelDefinition(panelId).title;
  const position = orderedPanelIds.indexOf(panelId) + 1;
  const group = groups.find((entry) => entry.panelIds.includes(panelId));
  const companions = (group?.panelIds ?? []).filter((id) => id !== panelId);
  const grouping =
    companions.length === 0
      ? "on its own"
      : `grouped with ${companions.map((id) => getLeftPanelDefinition(id).title).join(", ")}`;
  return `${title} is now panel ${position} of ${orderedPanelIds.length}, ${grouping}.`;
}

function readPanelId(value: UniqueIdentifier | undefined): LeftPanelId | null {
  return LEFT_PANEL_IDS.find((panelId) => panelId === value) ?? null;
}

function samePreview(
  left: SidebarPanelDropPreview | null,
  right: SidebarPanelDropPreview | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.targetPanelId === right.targetPanelId &&
    left.position === right.position
  );
}
