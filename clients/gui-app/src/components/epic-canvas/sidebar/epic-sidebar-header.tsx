/**
 * Epic sidebar header row - contains title, collapse/expand actions, and
 * section-specific Action components.
 */
import { useDraggable } from "@dnd-kit/core";
import {
  getLeftPanelSectionDragId,
  getPaneScopedDndId,
  LEFT_PANEL_RAIL_ITEM_DND_TYPE,
  type EpicCanvasLeftPanelRailDragData,
} from "@/components/epic-canvas/dnd/dnd";
import { type LeftPanelDefinition } from "@/components/epic-canvas/sidebar/epic-sidebar";
import { Button } from "@/components/ui/button";
import { ChevronRight } from "lucide-react";
import { useCallback, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import {
  useEpicLeftPanelStore,
  useLeftPanelSectionCollapsed,
} from "@/stores/epics/left-panel-store";
import { useMaybeSidebarBulkSelection } from "@/components/epic-canvas/sidebar/epic-sidebar-selection";
import {
  usePanelHeaderSearchOpen,
  usePanelHeaderSearchStore,
} from "@/stores/epics/panel-header-search-store";

interface PanelGroupSectionHeaderProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly panel: LeftPanelDefinition;
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
  readonly collapsed: boolean;
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
        <Actions
          epicId={props.epicId}
          tabId={props.tabId}
          collapsed={props.collapsed}
          mode="search"
        />
      )}
    </div>
  );
}

export function PanelGroupSectionHeader(props: PanelGroupSectionHeaderProps) {
  const Icon = props.panel.icon;
  const Actions = props.panel.Actions;
  const Subtitle = props.panel.Subtitle;
  const collapsed = useLeftPanelSectionCollapsed(props.panel.id);
  const toggleCollapsed = useEpicLeftPanelStore(
    (s) => s.togglePanelSectionCollapsed,
  );
  const dragData = useMemo<EpicCanvasLeftPanelRailDragData>(
    () => ({
      kind: LEFT_PANEL_RAIL_ITEM_DND_TYPE,
      viewTabId: props.tabId,
      panelId: props.panel.id,
      origin: "panel-section",
    }),
    [props.panel.id, props.tabId],
  );
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
        <Actions
          epicId={props.epicId}
          tabId={props.tabId}
          collapsed={collapsed}
          mode="selection"
        />
      </div>
    );
  }
  // Search mode takes the whole row rather than adding one below it, so the
  // list keeps its vertical position and the panel spends no resting space on
  // a mode that is off most of the time.
  //
  // Never while collapsed: the body - and with it the component that portals
  // the input in - is unmounted, so swapping would leave an empty row with no
  // input, no chevron, and no way back out.
  if (props.panel.supportsHeaderSearch && searchOpen && !collapsed) {
    return (
      <PanelHeaderSearchRow
        epicId={props.epicId}
        tabId={props.tabId}
        panel={props.panel}
        collapsed={collapsed}
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
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? "Expand" : "Collapse"} ${props.panel.title}`}
        className="-ml-1 size-5 text-muted-foreground aria-expanded:bg-transparent aria-expanded:text-muted-foreground hover:bg-muted hover:text-foreground"
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
      <button
        type="button"
        {...listeners}
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? "Expand" : "Collapse"} ${props.panel.title}`}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
        onClick={(event) => {
          event.stopPropagation();
          toggleCollapsed(props.panel.id);
        }}
      >
        <Icon className="size-4 shrink-0 text-muted-foreground/80 @max-[14rem]:hidden" />
        <div className="min-w-0">
          <p className="truncate text-ui-xs font-normal uppercase tracking-wide text-muted-foreground">
            {props.panel.title}
          </p>
          {Subtitle === null ? null : (
            <Subtitle epicId={props.epicId} tabId={props.tabId} />
          )}
        </div>
      </button>
      {Actions === null ? null : (
        <Actions
          epicId={props.epicId}
          tabId={props.tabId}
          collapsed={collapsed}
          mode="normal"
        />
      )}
    </div>
  );
}
