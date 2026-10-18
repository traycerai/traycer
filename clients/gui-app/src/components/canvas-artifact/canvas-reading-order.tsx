import { useRef } from "react";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CanvasPageItems } from "./canvas-model";
export function CanvasReadingOrder({
  boards,
  viewOnly,
  onCenter,
  onMove,
}: {
  readonly viewOnly?: boolean;
  readonly boards: CanvasPageItems["boards"];
  readonly onCenter: (path: string) => void;
  readonly onMove: (path: string, before: string | null) => void;
}) {
  const dragged = useRef<string | null>(null);
  return (
    <aside
      className="flex w-1/5 min-w-0 flex-col border-r bg-background"
      aria-label="Board reading order"
    >
      <h2 className="px-3 py-3 text-ui-sm font-medium">Reading order</h2>
      <ol className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {boards.map(([path, board], index) => (
          <li
            key={path}
            draggable={!viewOnly}
            onDragStart={(event) => {
              if (viewOnly) return;
              event.dataTransfer.setData("text/plain", path);
              dragged.current = path;
            }}
            onDragEnd={() => {
              dragged.current = null;
            }}
            onDragOver={(event) => {
              if (dragged.current !== null) event.preventDefault();
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (!viewOnly && dragged.current !== null)
                onMove(dragged.current, path);
              dragged.current = null;
            }}
            className="flex items-center gap-0.5 rounded-md hover:bg-foreground/5"
          >
            {viewOnly ? null : (
              <GripVertical className="size-3 shrink-0 text-muted-foreground" />
            )}
            <Button
              variant="ghost"
              size="sm"
              className="min-w-0 flex-1"
              onClick={() => onCenter(path)}
            >
              <span className="truncate">{board.title || path}</span>
            </Button>
            {viewOnly ? null : (
              <>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={index === 0}
                  aria-label={`Move ${board.title || path} earlier`}
                  onClick={() => onMove(path, boards[index - 1][0])}
                >
                  <ArrowUp />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  disabled={index === boards.length - 1}
                  aria-label={`Move ${board.title || path} later`}
                  onClick={() => onMove(path, boards[index + 2]?.[0] ?? null)}
                >
                  <ArrowDown />
                </Button>
              </>
            )}
          </li>
        ))}
      </ol>
    </aside>
  );
}
