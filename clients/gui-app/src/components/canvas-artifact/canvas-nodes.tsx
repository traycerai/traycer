import type { CanvasPageError } from "@/lib/sandbox/canvas-bridge";
import { CanvasErrorPill } from "./canvas-error-pill";
import {
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  NodeResizer,
  useStore,
  type NodeProps,
  type OnResizeEnd,
} from "@xyflow/react";
import { Expand, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { CanvasBoardFrame } from "./canvas-frame";
import { CanvasNoteContent } from "./canvas-note-content";
import { CanvasNoteToolbar } from "./canvas-note-toolbar";
import {
  useCanvasNodeActions,
  type CanvasFlowNode,
  type CanvasNodeActions,
} from "./canvas-node-context";
import { BOARD_HEADER_HEIGHT, boardFrame, boardName } from "./canvas-model";

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

function CanvasEditShield({
  path,
  width,
  height,
  actions,
}: {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly actions: CanvasNodeActions;
}) {
  if (
    actions.selectionEnabled &&
    actions.frameEvents?.renderOverlay !== undefined
  )
    return actions.frameEvents.renderOverlay(path, true);
  return (
    <>
      {actions.frameEvents?.renderOverlay?.(path, false)}
      <div
        data-canvas-frame-overlay=""
        className="absolute inset-0 [&]:pointer-events-auto"
        onPointerDown={(event) => {
          if (!actions.selectionEnabled) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          actions.frameEvents?.onEditPointer(path, {
            x: ((event.clientX - bounds.left) * width) / bounds.width,
            y: ((event.clientY - bounds.top) * height) / bounds.height,
          });
        }}
      />
    </>
  );
}

/** What lies over a board's frame: play pins, a pan pass-through, or the edit shield. */
function CanvasBoardOverlay({
  path,
  width,
  height,
  interactive,
  actions,
}: {
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly interactive: boolean;
  readonly actions: CanvasNodeActions;
}) {
  if (interactive && !actions.selectionEnabled)
    return <CanvasPlayPins actions={actions} path={path} />;
  // The self variant enables hits without adding xyflow's no-pan marker, so
  // a hand drag that starts here pans the canvas instead of reaching the page.
  // Comment pins and an open thread stay above it and keep their own markers.
  if (actions.panMode)
    return (
      <>
        <div aria-hidden className="absolute inset-0 [&]:pointer-events-auto" />
        {actions.frameEvents?.renderOverlay?.(path, false)}
      </>
    );
  return (
    <CanvasEditShield
      path={path}
      width={width}
      height={height}
      actions={actions}
    />
  );
}

function CanvasPlayPins(props: {
  readonly path: string;
  readonly actions: CanvasNodeActions;
}) {
  return props.actions.frameEvents?.renderOverlay?.(props.path, false);
}

function CanvasBoardButtons({
  path,
  title,
  actions,
}: {
  readonly path: string;
  readonly title: string;
  readonly actions: CanvasNodeActions;
}) {
  return (
    <div className="touch-auto flex items-center gap-0.5">
      {actions.play ? null : (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={`Play ${title} on canvas`}
          onClick={() => actions.startPlay(path)}
        >
          <Play />
        </Button>
      )}
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={`Play ${title} fullscreen`}
        onClick={() => actions.fullscreen(path)}
      >
        <Expand />
      </Button>
    </div>
  );
}

/**
 * The caption occupies authored canvas space, so it cannot grow into nearby
 * headings as the viewport zooms out. It remains the board's drag handle.
 */
function CanvasBoardHeader({
  path,
  title,
  error,
  actions,
}: {
  readonly path: string;
  readonly title: string;
  readonly error: CanvasPageError | null;
  readonly actions: CanvasNodeActions;
}) {
  const zoom = useStore((state) => state.transform[2]);
  // Preserve legibility near normal zoom, with a bounded 54px canvas
  // footprint instead of ever-growing screen-sized captions.
  const captionScale = Math.min(1.5, 1 / zoom);
  const [renaming, setRenaming] = useState(false);
  return (
    <div
      data-canvas-board-handle=""
      className="absolute bottom-full left-0 flex origin-bottom-left cursor-grab items-center gap-1 rounded-t-md border border-b-0 border-border bg-background px-2 text-foreground"
      style={{
        height: BOARD_HEADER_HEIGHT,
        width: `${100 / captionScale}%`,
        transform: `scale(${captionScale})`,
      }}
    >
      <div className="min-w-10 flex-1">
        {renaming ? (
          <CanvasBoardNameInput
            value={title}
            onDone={(name) => {
              if (name !== null) actions.renameBoard(path, name);
              setRenaming(false);
            }}
          />
        ) : (
          <span
            className="block truncate text-ui-sm font-semibold"
            onDoubleClick={() => {
              if (!actions.viewOnly && !actions.play) setRenaming(true);
            }}
          >
            {title}
          </span>
        )}
      </div>
      <CanvasErrorPill
        error={error}
        onAdd={
          actions.viewOnly
            ? null
            : () => {
                if (error !== null) actions.onAddError(path, error);
              }
        }
      />
      <CanvasBoardButtons path={path} title={title} actions={actions} />
    </div>
  );
}

function CanvasBoardNameInput({
  value,
  onDone,
}: {
  readonly value: string;
  readonly onDone: (name: string | null) => void;
}) {
  const cancelled = useRef(false);
  return (
    <Input
      className="touch-auto"
      aria-label="Board name"
      size="xs"
      defaultValue={value}
      ref={(node) => {
        node?.focus();
        node?.select();
      }}
      onBlur={(event) => {
        const name = event.currentTarget.value.trim();
        onDone(
          !cancelled.current && name.length > 0 && name !== value ? name : null,
        );
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.code === "Escape") {
          cancelled.current = true;
          event.currentTarget.blur();
        }
        if (event.code === "Enter") event.currentTarget.blur();
      }}
    />
  );
}

export const CanvasBoardNode = memo(function CanvasBoardNode({
  id,
  data,
  selected,
}: NodeProps<CanvasFlowNode>) {
  const actions = useCanvasNodeActions();
  const onResizeEnd = useResizeEnd(id, actions.resize);
  const { sourceForBoard } = actions;
  const [error, setError] = useState<CanvasPageError | null>(null);
  const board = data.board;
  const source = useMemo(
    () => (data.live ? sourceForBoard(data.path) : null),
    [sourceForBoard, data.path, data.live],
  );
  if (board === null) return null;
  const frame = boardFrame(board);
  const title = board.title || boardName(data.path);
  const interactive = data.play;
  const fullscreen = actions.fullscreenPath === data.path;
  return (
    <div
      className={cn(
        "relative h-full w-full rounded-(--canvas-radius) bg-card shadow-md ring-1 ring-foreground/25",
        selected && !data.play && "ring-2 ring-ring",
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
        isVisible={!actions.viewOnly && !data.play && selected}
        minWidth={80}
        minHeight={60}
        onResizeEnd={onResizeEnd}
      />
      {fullscreen ? null : (
        <CanvasBoardHeader
          path={data.path}
          title={title}
          error={error}
          actions={actions}
        />
      )}
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
          <div
            className={cn(
              "touch-auto h-full w-full [&]:pointer-events-auto",
              // Only a board in play takes drags and wheels for itself; every
              // other board lets the canvas pan across it.
              interactive && "canvas-nopan canvas-nowheel",
            )}
          >
            <CanvasBoardFrame
              path={data.path}
              title={title}
              source={source}
              events={actions.frameEvents}
              fullscreen={fullscreen}
              navigation={actions.navigation[data.path] ?? null}
              mode={interactive ? "play" : "edit"}
              onError={setError}
            />
          </div>
        )}
        <CanvasBoardOverlay
          path={data.path}
          width={frame.w}
          height={frame.h}
          interactive={interactive}
          actions={actions}
        />
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
  const readOnly = actions.viewOnly || data.play;
  const editing = !readOnly && actions.editingNote === data.path;
  return (
    <div
      className={cn(
        "relative h-full w-full",
        selected && !data.play && "outline outline-1 outline-ring",
        type === "sticky" &&
          "rounded-sm border border-border bg-(--canvas-note-fill) p-3 shadow-sm",
        type === "title" && "p-1",
      )}
      style={
        {
          "--canvas-note-fill": note.color ?? "var(--card)",
        } as CSSProperties
      }
    >
      <CanvasNoteToolbar
        id={data.path}
        note={note}
        visible={!readOnly && (selected || editing)}
      />
      <NodeResizer
        handleClassName="z-10"
        lineClassName="z-10"
        isVisible={!actions.viewOnly && !data.play && selected}
        minWidth={12}
        minHeight={12}
        onResizeEnd={onResizeEnd}
      />
      <CanvasNoteContent
        note={note}
        imageSource={imageSource}
        viewOnly={readOnly}
        editing={editing}
        onEdit={() => actions.setEditingNote(data.path)}
        onCommit={(text) => {
          actions.setNoteText(data.path, text);
          actions.setEditingNote(null);
        }}
        onGrow={(height) => {
          const next = Math.ceil(height + (type === "title" ? 8 : 26));
          // Grow around new text without undoing a manually enlarged note.
          if (height > 0 && next > (note.h ?? (type === "title" ? 64 : 160)))
            actions.updateNote(data.path, { h: next });
        }}
      />
    </div>
  );
});
