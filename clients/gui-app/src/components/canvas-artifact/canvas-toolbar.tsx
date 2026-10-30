import { useState, type ReactNode } from "react";
import {
  ArrowUpRight,
  ChevronDown,
  Circle,
  Hand,
  MousePointer2,
  Pen,
  Square,
  StickyNote,
  Type,
  Minus,
} from "lucide-react";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CanvasTool } from "./canvas-model";

const NAVIGATION_TOOLS = [
  { tool: "select", label: "Select", key: "V", icon: MousePointer2 },
  { tool: "hand", label: "Hand", key: "H", icon: Hand },
] as const;
const CONTENT_TOOLS = [
  { tool: "sticky", label: "Note", key: "N", icon: StickyNote },
  { tool: "title", label: "Text", key: "T", icon: Type },
  { tool: "pen", label: "Pen", key: "P", icon: Pen },
] as const;
const SHAPE_TOOLS = [
  { tool: "rect", label: "Rectangle", key: "R", icon: Square },
  { tool: "oval", label: "Oval", key: "O", icon: Circle },
  { tool: "line", label: "Line", key: "L", icon: Minus },
  { tool: "arrow", label: "Arrow", key: "A", icon: ArrowUpRight },
] as const;
type ShapeTool = (typeof SHAPE_TOOLS)[number]["tool"];
const ZOOM_PRESETS = [0.25, 0.5, 1, 2] as const;

export interface CanvasZoomModel {
  readonly ready: boolean;
  readonly percent: number;
  readonly canZoomIn: boolean;
  readonly canZoomOut: boolean;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly onFit: () => void;
  readonly onZoom: (zoom: number) => void;
}

/** The pages and tools pill floating at the canvas's top left. */
export function CanvasToolbar(props: {
  readonly viewOnly: boolean;
  readonly pages: ReactNode;
  readonly tool: CanvasTool;
  readonly onTool: (tool: CanvasTool) => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Canvas tools"
      className="flex items-center gap-0.5 rounded-lg border bg-popover p-1 shadow-sm"
    >
      {props.pages}
      {props.viewOnly ? null : (
        <>
          <ToolbarDivider />
          {NAVIGATION_TOOLS.map((item) => (
            <ToolButton key={item.tool} {...props} item={item} />
          ))}
          <ToolbarDivider />
          {CONTENT_TOOLS.map((item) => (
            <ToolButton key={item.tool} {...props} item={item} />
          ))}
          <ShapeTools {...props} />
        </>
      )}
    </div>
  );
}

/** Comments and the zoom menu at the top right. */
export function CanvasViewControls(props: {
  readonly viewOnly: boolean;
  readonly commenting?: boolean;
  readonly trailing: ReactNode;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly zoom: CanvasZoomModel;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Canvas view"
      className="flex items-center gap-0.5 rounded-lg border bg-popover p-1 shadow-sm"
    >
      {props.trailing}
      <ZoomMenu
        {...props}
        viewOnly={props.viewOnly || props.commenting === true}
      />
    </div>
  );
}

function ZoomMenu(props: {
  readonly viewOnly: boolean;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly zoom: CanvasZoomModel;
}) {
  const { zoom } = props;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={!zoom.ready}
          aria-label={`${zoom.percent}%, zoom`}
        >
          <span className="tabular-nums">{zoom.percent}%</span>
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={!zoom.canZoomIn} onSelect={zoom.onZoomIn}>
          Zoom in
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!zoom.canZoomOut} onSelect={zoom.onZoomOut}>
          Zoom out
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={zoom.onFit}>Fit to screen</DropdownMenuItem>
        <DropdownMenuSeparator />
        {ZOOM_PRESETS.map((preset) => (
          <DropdownMenuItem key={preset} onSelect={() => zoom.onZoom(preset)}>
            {preset * 100}%
          </DropdownMenuItem>
        ))}
        {props.viewOnly ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={!props.canUndo} onSelect={props.undo}>
              Undo
              <DropdownMenuShortcut>Ctrl Z</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!props.canRedo} onSelect={props.redo}>
              Redo
              <DropdownMenuShortcut>Ctrl ⇧ Z</DropdownMenuShortcut>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ToolButton(props: {
  readonly tool: CanvasTool;
  readonly onTool: (tool: CanvasTool) => void;
  readonly item: {
    readonly tool: CanvasTool;
    readonly label: string;
    readonly key: string;
    readonly icon: typeof Hand;
  };
}) {
  const { item } = props;
  const active = props.tool === item.tool;
  const Icon = item.icon;
  return (
    <TooltipWrapper
      label={`${item.label} (${item.key})`}
      side="bottom"
      sideOffset={undefined}
      align={undefined}
    >
      <Button
        variant={active ? "secondary" : "ghost"}
        size="icon-sm"
        aria-label={`${item.label} (${item.key})`}
        aria-pressed={active}
        onClick={() => props.onTool(item.tool)}
      >
        <Icon />
      </Button>
    </TooltipWrapper>
  );
}

/** The four shapes share one slot showing the last one used, as in design tools. */
function ShapeTools(props: {
  readonly tool: CanvasTool;
  readonly onTool: (tool: CanvasTool) => void;
}) {
  const [lastShape, setLastShape] = useState<ShapeTool>("rect");
  const activeShape = SHAPE_TOOLS.find(({ tool }) => tool === props.tool);
  const shown =
    activeShape ?? SHAPE_TOOLS.find(({ tool }) => tool === lastShape);
  const pick = (tool: ShapeTool): void => {
    setLastShape(tool);
    props.onTool(tool);
  };
  if (shown === undefined) return null;
  return (
    <div className="flex items-center">
      <ToolButton {...props} item={shown} onTool={() => pick(shown.tool)} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label="More shapes">
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {SHAPE_TOOLS.map(({ tool, label, key, icon: Icon }) => (
            <DropdownMenuItem key={tool} onSelect={() => pick(tool)}>
              <Icon />
              {label}
              <DropdownMenuShortcut>{key}</DropdownMenuShortcut>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function ToolbarDivider() {
  return <div aria-hidden className="mx-0.5 h-4 w-px bg-border" />;
}
