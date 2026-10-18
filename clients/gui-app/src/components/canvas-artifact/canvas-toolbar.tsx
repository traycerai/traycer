import {
  ArrowUpRight,
  Circle,
  Hand,
  MousePointer2,
  Pen,
  Play,
  Redo2,
  Square,
  StickyNote,
  Type,
  Undo2,
  Minus,
  ListOrdered,
} from "lucide-react";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { Button } from "@/components/ui/button";
import {
  ZoomControls,
  type ZoomControlsModel,
} from "@/components/epic-canvas/zoom-controls/zoom-controls";
import { CanvasZoomPresets } from "./canvas-zoom-presets";
import type { CanvasTool } from "./canvas-model";
const TOOLS = [
  { tool: "select", label: "Select", key: "V", icon: MousePointer2 },
  { tool: "hand", label: "Hand", key: "H", icon: Hand },
  { tool: "sticky", label: "Sticky note", key: "N", icon: StickyNote },
  { tool: "rect", label: "Rectangle", key: "R", icon: Square },
  { tool: "oval", label: "Oval", key: "O", icon: Circle },
  { tool: "line", label: "Line", key: "L", icon: Minus },
  { tool: "arrow", label: "Arrow", key: "A", icon: ArrowUpRight },
  { tool: "pen", label: "Pen", key: "P", icon: Pen },
  { tool: "title", label: "Title", key: "T", icon: Type },
] as const;
export function CanvasToolbar(props: {
  readonly tool: CanvasTool;
  readonly setTool: (tool: CanvasTool) => void;
  readonly play: boolean;
  readonly setPlay: (play: boolean) => void;
  readonly orderOpen: boolean;
  readonly toggleOrder: () => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly zoom: ZoomControlsModel;
  readonly onZoom: (zoom: number) => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Canvas tools"
      className="flex flex-wrap items-center gap-1 border-b bg-background px-2 py-1.5"
    >
      <Button
        variant={props.orderOpen ? "secondary" : "ghost"}
        size="icon-sm"
        aria-label="Reading order"
        aria-pressed={props.orderOpen}
        onClick={props.toggleOrder}
      >
        <ListOrdered className="size-4" />
      </Button>
      <div className="mx-1 h-4 w-px bg-border" />
      {TOOLS.map(({ tool, label, key, icon: Icon }) => (
        <TooltipWrapper
          key={tool}
          label={`${label} (${key})`}
          side="bottom"
          sideOffset={undefined}
          align={undefined}
        >
          <Button
            variant={props.tool === tool && !props.play ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label={`${label} (${key})`}
            aria-pressed={props.tool === tool && !props.play}
            onClick={() => {
              props.setPlay(false);
              props.setTool(tool);
            }}
          >
            <Icon className="size-4" />
          </Button>
        </TooltipWrapper>
      ))}
      <div className="mx-1 h-4 w-px bg-border" />
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Undo"
        disabled={!props.canUndo}
        onClick={props.undo}
      >
        <Undo2 className="size-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Redo"
        disabled={!props.canRedo}
        onClick={props.redo}
      >
        <Redo2 className="size-4" />
      </Button>
      <div className="min-w-0 flex-1" />
      <ZoomControls
        {...props.zoom}
        stepGroupClassName={undefined}
        anchorGroupClassName={undefined}
      />
      <CanvasZoomPresets onZoom={props.onZoom} disabled={!props.zoom.ready} />
      <Button
        variant={props.play ? "secondary" : "ghost"}
        size="sm"
        aria-label={props.play ? "Edit canvas" : "Play canvas"}
        aria-pressed={props.play}
        onClick={() => props.setPlay(!props.play)}
      >
        {props.play ? <MousePointer2 /> : <Play />}
        {props.play ? "Edit" : "Play"}
      </Button>
    </div>
  );
}
