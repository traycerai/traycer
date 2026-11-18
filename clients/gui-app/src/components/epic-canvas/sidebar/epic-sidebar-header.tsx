/**
 * Epic sidebar header row - the panel's title, its drag handle, its
 * section-specific Action components, and a collapse chevron for a section
 * that has somewhere to hand its space to.
 *
 * The chevron is drawn for a member of a STACKED PAIR and for nothing else
 * (L-157, L-166). A panel standing alone IS the sidebar body, so collapsing it
 * would leave the whole column empty with no way back from the rail, and
 * "collapse the sidebar" already has one owner in `mainCollapsedByTabId`. A
 * stacked section has a partner that takes the space, which is what makes the
 * control mean something again.
 *
 * The row is also the panel-section DRAG source, which is how a panel is
 * dropped onto the rail from the body.
 */
import { useDraggable } from "@dnd-kit/core";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useEpicLeftPanelStore } from "@/stores/epics/left-panel-store";
import {
  getLeftPanelSectionDragId,
  getPaneScopedDndId,
  LEFT_PANEL_RAIL_ITEM_DND_TYPE,
  type EpicCanvasLeftPanelRailDragData,
} from "@/components/epic-canvas/dnd/dnd";
import { useDragSourceDisabled } from "@/components/epic-canvas/dnd/use-drag-source-disabled";
import { type LeftPanelDefinition } from "@/components/epic-canvas/sidebar/epic-sidebar";
import { type LeftPanelSlotProps } from "@/components/epic-canvas/sidebar/left-panel-registry";
import { useCallback, useMemo, useRef, type ComponentType } from "react";
import { cn } from "@/lib/utils";
import { useMaybeSidebarBulkSelection } from "@/components/epic-canvas/sidebar/epic-sidebar-selection";
import {
  usePanelHeaderSearchOpen,
  usePanelHeaderSearchStore,
} from "@/stores/epics/panel-header-search-store";

interface LeftPanelSectionHeaderProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly panel: LeftPanelDefinition;
  /** One of a stacked pair: the only section that carries a chevron. */
  readonly collapsible: boolean;
  readonly collapsed: boolean;
}

/**
 * Portal target for an opted-in panel's search input. Rendered INSTEAD of the
 * standard header row (same `h-9`, so the body below never shifts), and left
 * empty here: the owning panel portals its own input in, keeping that input's
 * state, refs, and combobox ARIA wiring in a single component.
 */
function PanelHeaderSearchRow(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly panel: LeftPanelDefinition;
}) {
  const registerSearchSlot = usePanelHeaderSearchStore(
    (state) => state.registerSearchSlot,
  );
  const unregisterSearchSlot = usePanelHeaderSearchStore(
    (state) => state.unregisterSearchSlot,
  );
  const Actions = props.panel.Actions;
  const panelId = props.panel.id;
  const currentSlotRef = useRef<HTMLDivElement | null>(null);
  const setSlotRef = useCallback(
    (element: HTMLDivElement | null) => {
      const previous = currentSlotRef.current;
      if (previous !== null && previous !== element) {
        unregisterSearchSlot(props.tabId, panelId, previous);
      }
      currentSlotRef.current = element;
      if (element !== null) {
        registerSearchSlot(props.tabId, panelId, element);
      }
    },
    [panelId, props.tabId, registerSearchSlot, unregisterSearchSlot],
  );
  return (
    <div
      className="@container flex h-9 shrink-0 items-center gap-1 px-2"
      data-testid={`epic-sidebar-header-search-slot-${panelId}`}
    >
      <div ref={setSlotRef} className="min-w-0 flex-1" />
      {Actions === null ? null : (
        <Actions epicId={props.epicId} tabId={props.tabId} mode="search" />
      )}
    </div>
  );
}

/**
 * The icon, the name and the panel's own subtitle - the part of the row that
 * reads the same whether the row is a plain box or a collapse button.
 */
function LeftPanelSectionTitle(props: {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly epicId: string;
  readonly tabId: string;
  readonly Subtitle: ComponentType<LeftPanelSlotProps> | null;
}) {
  const { icon: Icon, Subtitle } = props;
  return (
    <>
      <Icon className="size-4 shrink-0 text-muted-foreground/80 @max-[14rem]:hidden" />
      <div className="min-w-0">
        <p className="truncate text-ui-xs font-normal uppercase tracking-wide text-muted-foreground">
          {props.title}
        </p>
        {Subtitle === null ? null : (
          <Subtitle epicId={props.epicId} tabId={props.tabId} />
        )}
      </div>
    </>
  );
}

export function LeftPanelSectionHeader(props: LeftPanelSectionHeaderProps) {
  const { collapsible, collapsed } = props;
  const Icon = props.panel.icon;
  const toggleCollapsed = useEpicLeftPanelStore(
    (s) => s.togglePanelSectionCollapsed,
  );
  const Actions = props.panel.Actions;
  const Subtitle = props.panel.Subtitle;
  const dragData = useMemo<EpicCanvasLeftPanelRailDragData>(
    () => ({
      kind: LEFT_PANEL_RAIL_ITEM_DND_TYPE,
      viewTabId: props.tabId,
      panelId: props.panel.id,
      origin: "panel-section",
    }),
    [props.panel.id, props.tabId],
  );
  const dragDisabled = useDragSourceDisabled();
  const {
    listeners,
    setNodeRef: dragRef,
    isDragging,
  } = useDraggable({
    id: getPaneScopedDndId(
      props.tabId,
      getLeftPanelSectionDragId(props.panel.id),
    ),
    data: dragData,
    disabled: dragDisabled,
  });
  const searchOpen = usePanelHeaderSearchOpen(props.tabId, props.panel.id);
  const bulkSelection = useMaybeSidebarBulkSelection();
  // Selection is a panel-wide mode, so its controls own the row instead of
  // competing horizontally with a title that no longer describes the mode.
  if (bulkSelection?.selectionMode === true && Actions !== null) {
    return (
      <div
        className="@container flex h-9 shrink-0 items-center justify-end px-2"
        data-panel-header-mode="selection"
      >
        <Actions epicId={props.epicId} tabId={props.tabId} mode="selection" />
      </div>
    );
  }
  // Search mode takes the whole row rather than adding one below it, so the
  // list keeps its vertical position and the panel spends no resting space on
  // a mode that is off most of the time.
  // Never while collapsed: the body - and with it the component that portals
  // the input in - is unmounted, so swapping would leave an empty row with no
  // input, no chevron and no way back out.
  if (props.panel.supportsHeaderSearch && searchOpen && !collapsed) {
    return (
      <PanelHeaderSearchRow
        epicId={props.epicId}
        tabId={props.tabId}
        panel={props.panel}
      />
    );
  }
  return (
    <div
      ref={dragRef}
      className={cn(
        "@container flex h-9 shrink-0 items-center justify-between gap-2 px-3",
        isDragging && "opacity-60",
      )}
    >
      {collapsible ? (
        <Button
          type="button"
          variant="muted"
          size="icon-xs"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? "Expand" : "Collapse"} ${props.panel.title}`}
          className="-ml-1 size-5 aria-expanded:bg-transparent aria-expanded:text-muted-foreground"
          onClick={(event) => {
            event.stopPropagation();
            toggleCollapsed(props.panel.id);
          }}
        >
          <ChevronRight
            className={cn(
              "size-3 transition-transform",
              !collapsed && "rotate-90",
            )}
          />
        </Button>
      ) : null}
      {/* A lone panel's title is the drag handle and nothing else: it has no
          collapse to toggle (L-157), so it is a plain row rather than a button
          announcing an action it cannot perform. A stacked section's title
          toggles the collapse its chevron owns. */}
      {collapsible ? (
        <button
          type="button"
          {...listeners}
          aria-expanded={!collapsed}
          // Named by its CONTENTS, which is the panel's own title: the chevron
          // beside it already carries "Collapse <panel>", and two controls
          // reading out the same name is one more thing for a screen reader to
          // disambiguate than the row actually has.
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
          onClick={(event) => {
            event.stopPropagation();
            toggleCollapsed(props.panel.id);
          }}
        >
          <LeftPanelSectionTitle
            icon={Icon}
            title={props.panel.title}
            epicId={props.epicId}
            tabId={props.tabId}
            Subtitle={collapsed ? null : Subtitle}
          />
        </button>
      ) : (
        <div
          {...listeners}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left active:cursor-grabbing"
        >
          <LeftPanelSectionTitle
            icon={Icon}
            title={props.panel.title}
            epicId={props.epicId}
            tabId={props.tabId}
            Subtitle={Subtitle}
          />
        </div>
      )}
      {Actions === null ? null : (
        <Actions epicId={props.epicId} tabId={props.tabId} mode="normal" />
      )}
    </div>
  );
}
