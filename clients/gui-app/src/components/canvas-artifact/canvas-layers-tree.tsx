import { useMemo, useRef, useState, useLayoutEffect } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";
import type { CanvasFrameRegistry } from "./canvas-frame-registry";
import type { CanvasBoardDocument } from "./canvas-board-document";
import { canvasLayerRows, describeCanvasLayer } from "./canvas-layer-model";
import { useCanvasSelectionStore } from "./canvas-selection-store";

export function CanvasLayersTree(props: {
  readonly artifactId: string;
  readonly boardPath: string;
  readonly document: CanvasBoardDocument;
  readonly registry: CanvasFrameRegistry;
  readonly owner: symbol;
}) {
  const active = useRef(true);
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const parent = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => canvasLayerRows(props.document), [props.document]);
  const selection = useCanvasSelectionStore((state) => state.selection);
  const [message, setMessage] = useState<string | null>(null);
  // Measurements are read here on each render, never passed through memoized children.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 36,
    overscan: 8,
  });
  const choose = async (marker: number): Promise<void> => {
    const state = useCanvasSelectionStore.getState();
    const generation = state.beginPick(
      props.owner,
      props.artifactId,
      props.boardPath,
    );
    try {
      const selection = await describeCanvasLayer(props, marker);
      if (!active.current) return;
      if (selection === null) {
        setMessage("This element is not visible in the current artboard.");
        return;
      }
      props.registry.selectBoard(props.boardPath);
      useCanvasSelectionStore
        .getState()
        .completePick(props.owner, generation, selection);
      setMessage(null);
    } catch {
      setMessage("This element is unavailable. Try again.");
    }
  };
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div
        ref={parent}
        role="tree"
        aria-label="Artboard layers"
        className="min-h-0 flex-1 overflow-auto"
      >
        <div
          className="relative w-full"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const row = rows[item.index];
            const selected =
              selection?.artifactId === props.artifactId &&
              selection.boardPath === props.boardPath &&
              row.marker !== null &&
              selection.element.marker === row.marker;
            return (
              <div
                key={row.key}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-selected={selected}
                className="absolute top-0 w-full"
                style={{
                  transform: `translateY(${item.start}px)`,
                  height: item.size,
                }}
              >
                <button
                  type="button"
                  disabled={row.generated}
                  className={cn(
                    "flex h-full w-full items-center gap-2 overflow-hidden rounded-sm pr-2 text-left text-ui-xs hover:bg-foreground/8",
                    selected && "bg-foreground/8",
                  )}
                  style={{ paddingLeft: 8 + Math.min(row.depth, 20) * 12 }}
                  onClick={() => {
                    if (row.marker !== null) void choose(row.marker);
                  }}
                >
                  <span className="shrink-0 font-mono">{row.label}</span>{" "}
                  <span className="truncate text-muted-foreground">
                    {row.generated ? "Generated" : row.preview}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
      {selection?.artifactId === props.artifactId &&
      selection.boardPath === props.boardPath &&
      selection.element.generated ? (
        <p className="p-2 text-ui-xs text-muted-foreground">
          {selection.element.tagName} · Generated — ask the agent to change this
          element.
        </p>
      ) : null}
      {message === null ? null : (
        <p role="status" className="p-2 text-ui-xs text-destructive">
          {message}
        </p>
      )}
    </div>
  );
}
