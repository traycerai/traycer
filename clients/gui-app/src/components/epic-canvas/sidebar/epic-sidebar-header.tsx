/**
 * Epic sidebar header row - contains title, collapse/expand actions, and
 * section-specific Action components.
 */
import { useDraggable } from "@dnd-kit/core";
import {
  getLeftPanelSectionDragId,
  LEFT_PANEL_RAIL_ITEM_DND_TYPE,
  type EpicCanvasLeftPanelRailDragData,
} from "@/components/epic-canvas/dnd/dnd";
import { type LeftPanelDefinition } from "@/components/epic-canvas/sidebar/epic-sidebar";
import { Button } from "@/components/ui/button";
import { ChevronRight } from "lucide-react";
import { useCallback, useMemo } from "react";
import { cn } from "@/lib/utils";
import {
  useEpicLeftPanelStore,
  useLeftPanelSectionCollapsed,
} from "@/stores/epics/left-panel-store";
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
function PanelHeaderSearchRow(props: { readonly panel: LeftPanelDefinition }) {
  const setSearchSlot = usePanelHeaderSearchStore((s) => s.setSearchSlot);
  const panelId = props.panel.id;
  const setSlotRef = useCallback(
    (element: HTMLDivElement | null) => setSearchSlot(panelId, element),
    [panelId, setSearchSlot],
  );
  return (
    <div
      ref={setSlotRef}
      className="flex h-9 shrink-0 items-center px-2"
      data-testid={`epic-sidebar-header-search-slot-${panelId}`}
    />
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
      panelId: props.panel.id,
      origin: "panel-section",
    }),
    [props.panel.id],
  );
  const {
    listeners,
    setNodeRef: dragRef,
    isDragging,
  } = useDraggable({
    id: getLeftPanelSectionDragId(props.panel.id),
    data: dragData,
  });
  const searchOpen = usePanelHeaderSearchOpen(props.panel.id);
  // Search mode takes the whole row rather than adding one below it, so the
  // list keeps its vertical position and the panel spends no resting space on
  // a mode that is off most of the time.
  //
  // Never while collapsed: the body - and with it the component that portals
  // the input in - is unmounted, so swapping would leave an empty row with no
  // input, no chevron, and no way back out.
  if (props.panel.supportsHeaderSearch && searchOpen && !collapsed) {
    return <PanelHeaderSearchRow panel={props.panel} />;
  }
  return (
    <div
      ref={dragRef}
      className={cn(
        "flex h-9 shrink-0 items-center justify-between gap-2 px-3",
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
        <Icon className="size-4 shrink-0 text-muted-foreground/80" />
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
        />
      )}
    </div>
  );
}
