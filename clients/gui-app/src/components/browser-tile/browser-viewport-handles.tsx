import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import {
  BROWSER_VIEWPORT_MIN_EDGE,
  BROWSER_VIEWPORT_MAX_EDGE,
} from "@traycer/protocol/host/browser/viewport";
import type { BrowserViewportController } from "./use-browser-viewport";
import { cn } from "@/lib/utils";
import { useAnimationFrameThrottle } from "@/hooks/use-animation-frame-throttle";

const HANDLES = [
  {
    name: "left",
    axis: "width",
    label: "Resize viewport width from left",
    x: -2,
    y: 0,
    className: "top-1/2 -left-6 -translate-y-1/2 cursor-ew-resize",
    gripClassName: "",
  },
  {
    name: "right",
    axis: "width",
    label: "Resize viewport width",
    x: 2,
    y: 0,
    className: "top-1/2 -right-6 -translate-y-1/2 cursor-ew-resize",
    gripClassName: "",
  },
  {
    name: "bottom",
    axis: "height",
    label: "Resize viewport height",
    x: 0,
    y: 1,
    className: "-bottom-6 left-1/2 -translate-x-1/2 cursor-ns-resize",
    gripClassName: "rotate-90",
  },
  {
    name: "bottom-left",
    axis: "both",
    label: "Resize viewport from bottom left",
    x: -2,
    y: 1,
    className: "-bottom-6 -left-6 cursor-nesw-resize",
    gripClassName: "-rotate-45",
  },
  {
    name: "bottom-right",
    axis: "both",
    label: "Resize viewport from bottom right",
    x: 2,
    y: 1,
    className: "-right-6 -bottom-6 cursor-nwse-resize",
    gripClassName: "rotate-45",
  },
] as const;

type ResizeHandle = (typeof HANDLES)[number];
type ResizeSize = { readonly width: number; readonly height: number };

interface ResizeDrag {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  readonly centered: boolean;
  readonly handle: ResizeHandle;
  pending: ResizeSize | null;
}

export function BrowserViewportHandles({
  controller,
}: {
  readonly controller: BrowserViewportController | null;
}) {
  const drag = useRef<ResizeDrag | null>(null);
  const applyPending = (current: ResizeDrag): void => {
    const size = current.pending;
    current.pending = null;
    if (
      size === null ||
      controller === null ||
      controller.disabled ||
      !controller.expanded
    )
      return;
    void controller.resize(size.width, size.height).catch(() => undefined);
  };
  const resize = useAnimationFrameThrottle((current: ResizeDrag) => {
    if (drag.current === current) applyPending(current);
  });
  if (
    controller === null ||
    !controller.expanded ||
    controller.disabled ||
    controller.size === null
  )
    return null;
  const start = (
    event: PointerEvent<HTMLElement>,
    handle: ResizeHandle,
  ): void => {
    if (event.button !== 0 || controller.size === null) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    controller.claim();
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      ...controller.size,
      scale: controller.resizeScale,
      centered: controller.resizeFromCenter(),
      handle,
      pending: null,
    };
  };
  const move = (event: PointerEvent<HTMLElement>): void => {
    const initial = drag.current;
    if (initial === null) return;
    // The preview is centered horizontally and anchored at its top edge.
    const widthDelta =
      ((event.clientX - initial.x) * initial.handle.x) /
      initial.scale /
      (initial.centered ? 1 : 2);
    const heightDelta =
      ((event.clientY - initial.y) * initial.handle.y) / initial.scale;
    let axis = initial.handle.axis;
    if (axis === "both") {
      axis =
        Math.abs(widthDelta / initial.width) >=
        Math.abs(heightDelta / initial.height)
          ? "width"
          : "height";
    }
    initial.pending = withRatio(
      {
        width: Math.round(initial.width + widthDelta),
        height: Math.round(initial.height + heightDelta),
      },
      controller.ratio,
      axis,
    );
    resize(initial);
  };
  const keyDown = (
    event: KeyboardEvent<HTMLElement>,
    handle: ResizeHandle,
  ): void => {
    if (controller.size === null) return;
    const horizontal = event.key === "ArrowLeft" || event.key === "ArrowRight";
    const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
    if (!horizontal && !vertical) return;
    if (handle.axis === "width" && !horizontal) return;
    if (handle.axis === "height" && !vertical) return;
    drag.current = null;
    event.preventDefault();
    const axis = horizontal ? "width" : "height";
    const increase = event.key === "ArrowRight" || event.key === "ArrowDown";
    let amount = (increase ? 1 : -1) * (event.shiftKey ? 10 : 1);
    if (horizontal && handle.x < 0) amount *= -1;
    const next = withRatio(
      { ...controller.size, [axis]: controller.size[axis] + amount },
      controller.ratio,
      axis,
    );
    void controller.resize(next.width, next.height).catch(() => undefined);
  };
  return (
    <>
      {HANDLES.map((handle) => {
        const corner = handle.axis === "both";
        const Tag = corner ? "button" : "div";
        const orientation = handle.axis === "width" ? "vertical" : "horizontal";
        return (
          <Tag
            key={handle.name}
            type={corner ? "button" : undefined}
            role={corner ? undefined : "separator"}
            data-viewport-action
            aria-label={handle.label}
            aria-orientation={corner ? undefined : orientation}
            aria-valuenow={corner ? undefined : controller.size?.[handle.axis]}
            aria-valuemin={corner ? undefined : BROWSER_VIEWPORT_MIN_EDGE}
            aria-valuemax={corner ? undefined : BROWSER_VIEWPORT_MAX_EDGE}
            tabIndex={0}
            className={cn(
              "absolute z-30 flex size-6 touch-none items-center justify-center rounded-sm text-muted-foreground outline-none hover:bg-foreground/5 hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              handle.className,
            )}
            onPointerDown={(event) => start(event, handle)}
            onPointerMove={move}
            onPointerUp={() => {
              const current = drag.current;
              drag.current = null;
              if (current !== null) applyPending(current);
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
            onLostPointerCapture={() => {
              drag.current = null;
            }}
            onKeyDown={(event) => keyDown(event, handle)}
          >
            <span
              aria-hidden
              className={cn(
                "pointer-events-none flex gap-0.5",
                handle.gripClassName,
              )}
            >
              <span className="h-3.5 w-0.5 rounded-full bg-current" />
              <span className="h-3.5 w-0.5 rounded-full bg-current" />
            </span>
          </Tag>
        );
      })}
    </>
  );
}

function withRatio(
  size: ResizeSize,
  ratio: number | null,
  axis: "width" | "height",
): ResizeSize {
  if (ratio === null) return size;
  return axis === "width"
    ? { width: size.width, height: Math.round(size.width / ratio) }
    : { width: Math.round(size.height * ratio), height: size.height };
}
