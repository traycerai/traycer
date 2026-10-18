import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  type CSSProperties,
} from "react";
import { NodeResizer, type NodeProps, type OnResizeEnd } from "@xyflow/react";
import { Expand, GripHorizontal, MousePointer2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CanvasBoardFrame } from "./canvas-frame";
import { CanvasNoteContent } from "./canvas-note-content";
import { CanvasInlineName } from "./canvas-inline-name";
import {
  useCanvasNodeActions,
  type CanvasFlowNode,
  type CanvasNodeActions,
} from "./canvas-node-context";
import { BOARD_HEADER_HEIGHT, boardFrame } from "./canvas-model";

function useResizeEnd(
  id: string,
  resize: CanvasNodeActions["resize"],
): OnResizeEnd {
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (_event, frame) => {
    // The installed resizer can finish its gesture after its node unmounts.
    if (mounted.current) resize(id, frame);
  };
}

export const CanvasBoardNode = memo(function CanvasBoardNode({
  id,
  data,
  selected,
}: NodeProps<CanvasFlowNode>) {
  const actions = useCanvasNodeActions();
  const onResizeEnd = useResizeEnd(id, actions.resize);
  const { sourceForBoard } = actions;
  const board = data.board;
  const source = useMemo(
    () => (data.live ? sourceForBoard(data.path) : null),
    [sourceForBoard, data.path, data.live],
  );
  if (board === null) return null;
  const frame = boardFrame(board);
  const title = board.title || data.path;
  const interactive = data.play && board.is_interactive === true;
  return (
    <div
      className={cn(
        "relative h-full w-full rounded-(--canvas-radius) bg-card shadow-sm ring-1 ring-border",
        selected && "ring-2 ring-ring",
      )}
      style={
        {
          "--canvas-radius": `${Math.max(0, board.radius ?? 0)}px`,
        } as CSSProperties
      }
    >
      <NodeResizer
        handleClassName="z-10"
        lineClassName="z-10"
        isVisible={selected ? !data.play : false}
        minWidth={80}
        minHeight={60}
        onResizeEnd={onResizeEnd}
      />
      <div
        data-canvas-board-handle=""
        className="absolute inset-x-0 bottom-full flex cursor-grab items-center gap-1 rounded-t-md border border-b-0 bg-card px-2 text-card-foreground"
        style={{ height: BOARD_HEADER_HEIGHT }}
      >
        <GripHorizontal className="size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <CanvasInlineName
            value={title}
            label={`Rename ${title}`}
            onCommit={(name) => actions.renameBoard(data.path, name)}
          />
        </div>
        <div className="touch-auto flex items-center gap-0.5">
          <Button
            type="button"
            size="icon-xs"
            variant={board.is_interactive ? "secondary" : "ghost"}
            aria-label={`Play ${title} on canvas`}
            aria-pressed={board.is_interactive === true}
            onClick={() => actions.toggleInteractive(data.path)}
          >
            {board.is_interactive ? <Play /> : <MousePointer2 />}
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={`Open ${title} full screen`}
            onClick={() => actions.fullscreen(data.path)}
          >
            <Expand />
          </Button>
        </div>
      </div>
      <div className="relative h-full w-full overflow-hidden rounded-(--canvas-radius)">
        {source === null ? (
          <div
            role="img"
            aria-label={`${title} preview`}
            className="flex h-full w-full flex-col items-center justify-center gap-2 bg-foreground/5 text-muted-foreground"
          >
            <span className="max-w-full truncate px-4 text-ui-sm">{title}</span>
            <span className="text-ui-xs tabular-nums">
              {Math.round(frame.w)} × {Math.round(frame.h)}
            </span>
          </div>
        ) : (
          <div className="touch-auto overscroll-contain pointer-events-auto h-full w-full">
            <CanvasBoardFrame
              path={data.path}
              title={title}
              source={source}
              events={actions.frameEvents}
              fullscreen={false}
            />
          </div>
        )}
        {/* The self variant enables hits without adding xyflow's no-pan marker. */}
        {!interactive ? (
          <div
            data-canvas-frame-overlay=""
            className="absolute inset-0 [&]:pointer-events-auto"
            onPointerDown={(event) => {
              const bounds = event.currentTarget.getBoundingClientRect();
              actions.frameEvents?.onEditPointer(data.path, {
                x: ((event.clientX - bounds.left) * frame.w) / bounds.width,
                y: ((event.clientY - bounds.top) * frame.h) / bounds.height,
              });
            }}
          />
        ) : null}
      </div>
    </div>
  );
});

export const CanvasNoteNode = memo(function CanvasNoteNode({
  id,
  data,
  selected,
}: NodeProps<CanvasFlowNode>) {
  const actions = useCanvasNodeActions();
  const onResizeEnd = useResizeEnd(id, actions.resize);
  const { sourceForBoard } = actions;
  const note = data.note;
  const imagePath = note?.type === "image" ? note.src : undefined;
  const imageSource = useMemo(
    () => (imagePath ? sourceForBoard(imagePath) : null),
    [sourceForBoard, imagePath],
  );
  if (note === null) return null;
  const type = note.type ?? "sticky";
  return (
    <div
      className={cn(
        "relative h-full w-full",
        selected && "outline outline-1 outline-ring",
        type === "sticky" &&
          "rounded-sm border border-border bg-card p-3 shadow-sm",
        type === "title" && "p-1",
      )}
    >
      <NodeResizer
        handleClassName="z-10"
        lineClassName="z-10"
        isVisible={selected ? !data.play : false}
        minWidth={12}
        minHeight={12}
        onResizeEnd={onResizeEnd}
      />
      <CanvasNoteContent
        note={note}
        imageSource={imageSource}
        onCommit={(text) => actions.setNoteText(data.path, text)}
      />
    </div>
  );
});
