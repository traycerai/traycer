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
import { useMemo } from "react";
import { cn } from "@/lib/utils";
import {
  useEpicLeftPanelStore,
  useLeftPanelSectionCollapsed,
} from "@/stores/epics/left-panel-store";

interface PanelGroupSectionHeaderProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly panel: LeftPanelDefinition;
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
