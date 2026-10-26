import type { CanvasPageError } from "@/lib/sandbox/canvas-bridge";
import type { CanvasFrameEvents } from "./canvas-frame";
import { CanvasErrorPill } from "./canvas-error-pill";
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import type { CanvasLayoutSnapshot } from "@traycer/protocol/persistence/epic/canvas-layout";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  WINDOW_LEADING_INSET_CLASS,
  WINDOW_TRAILING_INSET_CLASS,
} from "@/components/layout/header/title-bar-drag";
import { cn } from "@/lib/utils";
import {
  adjacentFullscreenBoard,
  fullscreenBoardSequence,
} from "./canvas-model";

export type CanvasFullscreenSizing = "fit" | "fill";

export function CanvasFullscreen({
  path,
  snapshot,
  errors,
  events,
  viewOnly,
  sizing,
  onSizing,
  onSelect,
  onClose,
  container,
}: {
  readonly path: string | null;
  readonly snapshot: CanvasLayoutSnapshot;
  readonly errors: Readonly<Record<string, CanvasPageError | null | undefined>>;
  readonly events: CanvasFrameEvents;
  readonly viewOnly: boolean;
  readonly sizing: CanvasFullscreenSizing;
  readonly onSizing: (mode: CanvasFullscreenSizing) => void;
  readonly onSelect: (path: string) => void;
  readonly onClose: () => void;
  readonly container: HTMLElement | null;
}) {
  if (path === null) return null;
  const board = snapshot.boards[path];
  const error = errors[path] ?? null;
  const previous = adjacentFullscreenBoard(snapshot, path, -1);
  const next = adjacentFullscreenBoard(snapshot, path, 1);
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-2 border-b bg-background px-3 py-2",
        WINDOW_LEADING_INSET_CLASS,
        WINDOW_TRAILING_INSET_CLASS,
      )}
    >
      <Button data-canvas-exit variant="ghost" size="sm" onClick={onClose}>
        <ArrowLeft />
        Back to canvas
      </Button>
      {/* The steppers sit before the title so they keep their place while
          the title changes width from board to board. */}
      <div className="flex shrink-0 items-center">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Previous board"
          disabled={previous === null}
          onClick={() => {
            if (previous !== null) onSelect(previous);
          }}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Next board"
          disabled={next === null}
          onClick={() => {
            if (next !== null) onSelect(next);
          }}
        >
          <ChevronRight />
        </Button>
      </div>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="min-w-0"
            aria-label="Choose board"
          >
            <span className="truncate">{board.title || path}</span>
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent container={container}>
          {fullscreenBoardSequence(snapshot).map((item) => (
            <DropdownMenuItem key={item} onSelect={() => onSelect(item)}>
              {snapshot.boards[item].title || item}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <CanvasErrorPill
        error={error}
        onAdd={
          viewOnly
            ? null
            : () => {
                if (error === null) return;
                onClose();
                events.onAddError?.(path, error);
              }
        }
      />
      {events.renderToolbarControls?.()}
      <div
        className="ml-auto flex shrink-0 items-center gap-1"
        role="group"
        aria-label="Board sizing"
      >
        <Button
          size="sm"
          variant={sizing === "fit" ? "secondary" : "ghost"}
          aria-pressed={sizing === "fit"}
          onClick={() => onSizing("fit")}
        >
          Fit
        </Button>
        <Button
          size="sm"
          variant={sizing === "fill" ? "secondary" : "ghost"}
          aria-pressed={sizing === "fill"}
          onClick={() => onSizing("fill")}
        >
          Fill width
        </Button>
      </div>
    </div>
  );
}
