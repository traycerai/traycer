/**
 * Layout ▸ Sidebar: the epic sidebar's own layout.
 *
 * The Panels list is a SECOND VIEW onto `left-panel-store`, never a second
 * source of truth. Its checkboxes write the override the rail's right-click
 * menu writes, and its reordering commits through `applyPanelGroups` after
 * resolving with the same pure `moveLeftPanel*` helpers the rail's DnD uses
 * (see `sidebar-panel-moves.ts`). So a change here is on the rail immediately,
 * a change on the rail is here, and neither can express a grouping the other
 * cannot.
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
import { EllipsisVertical, GripVertical } from "lucide-react";
import {
  getLeftPanelRailDropPositionFromPoint,
  type LeftPanelRailDropPosition,
} from "@/components/epic-canvas/dnd/dnd";
import {
  getLeftPanelDefinition,
  isLeftPanelVisible,
  LEFT_PANEL_DEFINITIONS,
  type LeftPanelAvailabilityContext,
} from "@/components/epic-canvas/sidebar/left-panel-registry";
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
import { useIsMobileViewport } from "@/hooks/ui/use-mobile-viewport";
import { trackSettingChanged, type AnalyticsSetting } from "@/lib/analytics";
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

function trackLayoutSetting(setting: AnalyticsSetting): void {
  trackSettingChanged("layout", setting);
}

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
 * The panel list, or a note in its place.
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
      const position = getLeftPanelRailDropPositionFromPoint(point, over.rect);
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
          Drag to reorder, or drop a panel onto another to stack them into one
          tabbed panel. Uncheck a panel to keep it out of the rail.
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
        <div className="space-y-1.5">
          {groups.map((group) => (
            <div
              key={group.panelIds[0]}
              data-testid={`layout-sidebar-panel-group-${group.panelIds[0]}`}
              className="rounded-md border border-border/60 bg-foreground/3 p-1"
            >
              {group.panelIds.map((panelId) => (
                <SidebarPanelRow
                  key={panelId}
                  panelId={panelId}
                  groups={groups}
                  context={context}
                  visibleCount={visibleCount}
                  preview={preview}
                  onRunAction={runRowAction}
                />
              ))}
            </div>
          ))}
        </div>
      </DndContext>
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

interface SidebarPanelRowProps {
  readonly panelId: LeftPanelId;
  readonly groups: ReadonlyArray<LeftPanelGroup>;
  readonly context: LeftPanelAvailabilityContext;
  readonly visibleCount: number;
  readonly preview: SidebarPanelDropPreview | null;
  readonly onRunAction: (
    panelId: LeftPanelId,
    groups: ReadonlyArray<LeftPanelGroup>,
  ) => void;
}

function SidebarPanelRow(props: SidebarPanelRowProps): ReactNode {
  const { panelId, groups, context, visibleCount, preview, onRunAction } =
    props;
  const definition = getLeftPanelDefinition(panelId);
  const setOverride = useLeftPanelStore(
    (state) => state.setPanelVisibilityOverride,
  );
  const {
    listeners,
    setNodeRef: dragRef,
    isDragging,
  } = useDraggable({ id: panelId });
  const { setNodeRef: dropRef } = useDroppable({ id: panelId });
  const setRowRef = useMemo(
    () => mergeRefs<HTMLDivElement>(dragRef, dropRef),
    [dragRef, dropRef],
  );

  const visible = isLeftPanelVisible(definition, context);
  const autoVisible = definition.isAutoVisible(context);
  // The last panel standing keeps its slot, exactly as in the rail menu: the
  // sidebar body always renders SOME panel, so an empty rail would leave the
  // two disagreeing with no icon to click back.
  const locked = visible && visibleCount === 1;
  const actions = sidebarPanelRowActions(groups, panelId);
  const previewPosition =
    preview !== null && preview.targetPanelId === panelId
      ? preview.position
      : null;
  const Icon = definition.icon;

  return (
    <div
      ref={setRowRef}
      data-testid={`layout-sidebar-panel-${panelId}`}
      className={cn(
        "relative flex items-center gap-2 rounded-sm px-1.5 py-1",
        isDragging && "opacity-50",
        previewPosition === "combine" && "bg-primary/10 ring-1 ring-primary/60",
      )}
    >
      {previewPosition === "before" ? (
        <SidebarPanelDropLine
          edge="top"
          spansCard={isSidebarPanelGroupBoundary(groups, panelId, "before")}
        />
      ) : null}
      <span
        {...listeners}
        aria-hidden
        data-testid={`layout-sidebar-panel-handle-${panelId}`}
        className="flex cursor-grab touch-none items-center text-muted-foreground/70"
      >
        <GripVertical className="size-4" />
      </span>
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
      {previewPosition === "after" ? (
        <SidebarPanelDropLine
          edge="bottom"
          spansCard={isSidebarPanelGroupBoundary(groups, panelId, "after")}
        />
      ) : null}
    </div>
  );
}

/**
 * Where the panel would land, drawn so the two OUTCOMES look different: a line
 * reaching past the card's edges lands the panel in a card of its own, a line
 * inset between two rows nests it in the card it is drawn inside. Same
 * boundary rule the drop resolves through, so the picture cannot promise a
 * grouping the commit would not make.
 */
function SidebarPanelDropLine(props: {
  readonly edge: "top" | "bottom";
  readonly spansCard: boolean;
}): ReactNode {
  return (
    <DropLine
      orientation="horizontal"
      glow={props.spansCard}
      className={cn(
        "absolute",
        // A card-edge line clears the card's own `p-1` so it lands ON the
        // border it is about to put the panel outside of, rather than a few
        // pixels inside the card it is leaving.
        props.spansCard ? "-inset-x-2" : "inset-x-0",
        props.edge === "top" && (props.spansCard ? "-top-1" : "-top-px"),
        props.edge === "bottom" &&
          (props.spansCard ? "-bottom-1" : "-bottom-px"),
      )}
      testId="layout-sidebar-panel-drop-line"
    />
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
 * The pointer-free path through the same move helpers the drag resolves
 * through, so every order a keyboard user reaches is an order a drag could
 * have produced. Not always in ONE drag: swapping the two members of a
 * two-panel card takes a step here and two by pointer, because every boundary
 * inside such a card is a no-op.
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
 * Where a panel ended up, in the terms the list shows: its place in the whole
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
