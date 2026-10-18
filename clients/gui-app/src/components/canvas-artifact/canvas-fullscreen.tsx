import { useState } from "react";
import type { CanvasPageError } from "@/lib/sandbox/canvas-bridge";
import { CanvasErrorPill } from "./canvas-error-pill";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { CanvasLayoutSnapshot } from "@traycer/protocol/persistence/epic/canvas-layout";
import type { SandboxSource } from "@/components/sandbox/sandbox-frame";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { CanvasBoardFrame, type CanvasFrameEvents } from "./canvas-frame";
import { boardFrame } from "./canvas-model";
export function CanvasFullscreen({
  path,
  viewOnly,
  snapshot,
  sourceForBoard,
  events,
  onSelect,
  onClose,
}: {
  readonly viewOnly: boolean;
  readonly path: string;
  readonly snapshot: CanvasLayoutSnapshot;
  readonly sourceForBoard: (path: string) => SandboxSource | null;
  readonly events: CanvasFrameEvents | null;
  readonly onSelect: (path: string) => void;
  readonly onClose: () => void;
}) {
  const [error, setError] = useState<CanvasPageError | null>(null);
  const board = snapshot.boards[path];
  if (!Object.hasOwn(snapshot.boards, path)) return null;
  const frame = boardFrame(board);
  const index = snapshot.order.indexOf(path);
  const source = sourceForBoard(path);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        layout="banded"
        className="w-full grid-rows-[auto_minmax(0,1fr)] sm:max-w-full"
        style={{
          height: "var(--spacing-safe-dvh)",
          maxWidth: "var(--safe-area-width)",
        }}
        aria-describedby={undefined}
        onKeyDown={(event) => {
          if (event.code === "Escape") onClose();
        }}
      >
        <div className="flex items-center gap-3 border-b px-4 py-2 pr-12">
          <DialogTitle size="sm" className="min-w-0 flex-1">
            {board.title || path}
          </DialogTitle>
          <CanvasErrorPill
            error={error}
            onAdd={
              viewOnly
                ? null
                : () => {
                    if (error !== null) {
                      onClose();
                      events?.onAddError?.(path, error);
                    }
                  }
            }
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous board"
            disabled={index <= 0}
            onClick={() => onSelect(snapshot.order[index - 1])}
          >
            <ChevronLeft />
          </Button>
          <span className="text-ui-xs tabular-nums text-muted-foreground">
            {index + 1} / {snapshot.order.length}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next board"
            disabled={index >= snapshot.order.length - 1}
            onClick={() => onSelect(snapshot.order[index + 1])}
          >
            <ChevronRight />
          </Button>
        </div>
        <div className="min-h-0 overflow-auto bg-canvas p-4">
          {/* Board pixels are the authored viewport, not a fixed layout surface. */}
          <div
            className="mx-auto bg-background shadow-sm"
            style={{ width: frame.w, height: frame.h }}
          >
            {source === null ? (
              <div className="flex h-full items-center justify-center text-muted-foreground">
                {board.title || path}
              </div>
            ) : (
              <CanvasBoardFrame
                key={path}
                mode="play"
                onError={setError}
                path={path}
                title={board.title || path}
                source={source}
                events={events}
                fullscreen
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
