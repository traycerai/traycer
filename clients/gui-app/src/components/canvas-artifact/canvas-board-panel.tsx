import { useState } from "react";
import {
  readCanvasLayout,
  setBoardFrame,
} from "@traycer/protocol/persistence/epic/canvas-layout";
import { Button } from "@/components/ui/button";
import type { CanvasLayoutStore } from "./canvas-layout-store";
import { boardFrame } from "./canvas-model";
import { CanvasStyleInput } from "./canvas-style-input";
import { useCanvasLayoutState } from "./use-canvas-layout";

export function CanvasBoardPanel({
  store,
  boardPath,
  contentHeight,
}: {
  readonly store: CanvasLayoutStore;
  readonly boardPath: string;
  readonly contentHeight: number | null;
}) {
  const { layout } = useCanvasLayoutState(store);
  const [message, setMessage] = useState<string | null>(null);
  if (!Object.hasOwn(layout.boards, boardPath)) return null;
  const board = layout.boards[boardPath];
  const frame = boardFrame(board);
  const setDimension = (property: "w" | "h", value: string): boolean => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
      setMessage("Enter a size greater than zero.");
      return false;
    }
    setMessage(null);
    let saved = false;
    store.transact((handle) => {
      const current = readCanvasLayout(handle).boards;
      if (Object.hasOwn(current, boardPath)) {
        setBoardFrame(handle, boardPath, {
          ...boardFrame(current[boardPath]),
          [property]: number,
        });
        saved = true;
      }
    });
    return saved;
  };
  return (
    <section
      aria-label="Artboard properties"
      className="grid min-w-0 gap-3 border-t p-3"
    >
      <span className="truncate text-ui-sm font-medium">Artboard</span>
      <div className="grid grid-cols-2 gap-3">
        <CanvasStyleInput
          key={`${boardPath}:width`}
          label="Board width"
          value={String(frame.w)}
          disabled={false}
          onCommit={(value) => Promise.resolve(setDimension("w", value))}
        />
        <CanvasStyleInput
          key={`${boardPath}:height`}
          label="Board height"
          value={String(frame.h)}
          disabled={false}
          onCommit={(value) => Promise.resolve(setDimension("h", value))}
        />
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={
          contentHeight === null ||
          !Number.isFinite(contentHeight) ||
          contentHeight <= 0
        }
        onClick={() => {
          if (contentHeight !== null)
            setDimension("h", String(Math.ceil(contentHeight)));
        }}
      >
        Fit to content
      </Button>
      {message === null ? null : (
        <p role="status" className="text-ui-sm text-destructive">
          {message}
        </p>
      )}
    </section>
  );
}
